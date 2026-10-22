import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { Server } from 'socket.io'

/**
 * 联机服务器（阶段 2：位置同步 + 门禁审批）
 *
 * 启动方式：npm run server
 * 默认端口 3001，浏览器通过 WebSocket 连上来。
 *
 * 门禁审批的职责划分：
 *   · 访客右键敲门 → knock
 *   · 服务器找到该地块在线的主人 → knock-request（只发给主人窗口）
 *   · 主人点 Accept / Reject → knock-response
 *   · 服务器把结果告诉访客（knock-result），并把门状态广播给所有窗口（gate-state）
 * 门「开 / 关」只认服务器广播，任何客户端都不能单方面把门开了。
 */

const PORT = Number(process.env.MULTIPLAYER_PORT) || 3001

// 地块归属与边界：与前端共用同一份数据，服务器据此判断谁有资格开关门
const plots = JSON.parse(readFileSync(new URL('../shared/plots.json', import.meta.url), 'utf8'))
const plotsById = new Map(plots.map((plot) => [ plot.id, plot ]))

const KNOCK_TIMEOUT = 30 * 1000        // 主人多久没响应就自动取消请求
const KNOCK_COOLDOWN = 3 * 1000        // 同一个人两次敲门的最小间隔，防连点刷屏
const GATE_OPEN_DURATION = 30 * 1000   // 门开多久后自动关上，避免一直敞着

const httpServer = createServer((request, response) =>
{
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('FOLIO multiplayer server is running\n')
})

const io = new Server(httpServer, {
    cors: { origin: '*' },
})

// socket.id -> { id, name, plotId, position, rotationY }
const players = new Map()

// plotId -> { open, timer }
const gates = new Map()

// requestId -> { id, plotId, visitorId, ownerId, timer }
const requests = new Map()

// socket.id -> 上次敲门时间
const lastKnockAt = new Map()

let requestSequence = 0

function isInsidePlot(_player, _plot)
{
    if(!_plot || !Array.isArray(_player.position))
        return false

    const x = _player.position[0]
    const z = _player.position[2]

    return x >= _plot.bounds.minX && x <= _plot.bounds.maxX &&
           z >= _plot.bounds.minZ && z <= _plot.bounds.maxZ
}

function findOwnerId(_plotId)
{
    for(const player of players.values())
    {
        if(player.plotId === _plotId)
            return player.id
    }

    return null
}

// 门状态由服务器统一下发：所有窗口看到的是同一扇门
function setGate(_plotId, _open)
{
    const gate = gates.get(_plotId) || { open: false, timer: null }

    if(gate.timer)
        clearTimeout(gate.timer)

    gate.open = _open
    gate.timer = _open ? setTimeout(() => setGate(_plotId, false), GATE_OPEN_DURATION) : null
    gates.set(_plotId, gate)

    io.emit('gate-state', { plotId: _plotId, open: gate.open })
}

function clearRequest(_requestId)
{
    const request = requests.get(_requestId)
    if(!request)
        return null

    clearTimeout(request.timer)
    requests.delete(_requestId)

    return request
}

// 新连上来的窗口补发当前门状态，避免有人看到门还关着
function syncGates(_socket)
{
    for(const [ plotId, gate ] of gates)
        _socket.emit('gate-state', { plotId: plotId, open: gate.open })
}

io.on('connection', (socket) =>
{
    socket.on('join', (data) =>
    {
        const name = String(data?.name || 'Visitor').slice(0, 24)
        const plotId = plotsById.has(data?.plotId) ? data.plotId : null
        const existing = players.get(socket.id)

        if(existing)
        {
            // 游戏内换了账号：只更新身份，不重复广播"新玩家"
            existing.name = name
            existing.plotId = plotId
            io.emit('players', [ ...players.values() ])
            syncGates(socket)
            return
        }

        const player = {
            id: socket.id,
            name: name,
            plotId: plotId,
            position: [ 0, 0, 0 ],
            rotationY: 0,
        }

        players.set(socket.id, player)

        // 先把自己身边已有的人发给他，再告诉别人他来了
        socket.emit('players', [ ...players.values() ])
        socket.broadcast.emit('player-joined', player)
        syncGates(socket)
    })

    socket.on('move', (data) =>
    {
        const player = players.get(socket.id)
        if(!player || !Array.isArray(data?.position) || data.position.length !== 3)
            return

        player.position = data.position
        player.rotationY = Number(data.rotationY) || 0

        // volatile：网络拥堵时允许丢帧，玩家位置不需要可靠送达
        socket.broadcast.volatile.emit('player-moved', {
            id: socket.id,
            position: player.position,
            rotationY: player.rotationY,
        })
    })

    /* ------------------------------------------------------------------ *
     *  门禁：访客敲门 → 主人审批
     * ------------------------------------------------------------------ */

    socket.on('knock', (data) =>
    {
        const visitor = players.get(socket.id)
        const plot = plotsById.get(data?.plotId)
        if(!visitor || !plot)
            return

        // 主人自己不用敲门
        if(visitor.plotId === plot.id)
            return

        // 防连点
        const now = Date.now()
        if(now - (lastKnockAt.get(socket.id) || 0) < KNOCK_COOLDOWN)
            return
        lastKnockAt.set(socket.id, now)

        // 同一块地同时只处理一个请求，避免主人连弹好几个窗
        for(const request of requests.values())
        {
            if(request.plotId === plot.id)
                return socket.emit('knock-result', { plotId: plot.id, approved: false, reason: 'busy' })
        }

        const ownerId = findOwnerId(plot.id)
        const ownerSocket = ownerId ? io.sockets.sockets.get(ownerId) : null

        if(!ownerSocket)
            return socket.emit('knock-result', { plotId: plot.id, approved: false, reason: 'owner-offline' })

        const request = {
            id: `k${++requestSequence}`,
            plotId: plot.id,
            visitorId: socket.id,
            ownerId: ownerId,
            timer: null,
        }

        request.timer = setTimeout(() =>
        {
            clearRequest(request.id)
            socket.emit('knock-result', { plotId: plot.id, approved: false, reason: 'timeout' })
            io.sockets.sockets.get(request.ownerId)?.emit('knock-cancelled', { id: request.id })
        }, KNOCK_TIMEOUT)

        requests.set(request.id, request)

        // 访客只知道"请求已发出"，门由主人的审批结果决定
        socket.emit('knock-sent', { id: request.id, plotId: plot.id })

        // 只有这块地的主人窗口弹出审批
        ownerSocket.emit('knock-request', {
            id: request.id,
            plotId: plot.id,
            visitorName: visitor.name,
        })
    })

    socket.on('knock-response', (data) =>
    {
        const request = requests.get(String(data?.id))
        if(!request || request.ownerId !== socket.id)
            return

        clearRequest(request.id)

        io.sockets.sockets.get(request.visitorId)?.emit('knock-result', {
            plotId: request.plotId,
            approved: !!data.approved,
        })

        if(data.approved)
            setGate(request.plotId, true)
    })

    // 主人直接开门 / 门里的人在门内开门：同样走服务器广播，避免各窗口状态不一致
    socket.on('gate-set', (data) =>
    {
        const player = players.get(socket.id)
        const plot = plotsById.get(data?.plotId)
        if(!player || !plot)
            return

        const allowed = player.plotId === plot.id || isInsidePlot(player, plot)
        if(!allowed)
            return

        setGate(plot.id, !!data.open)
    })

    socket.on('disconnect', () =>
    {
        players.delete(socket.id)
        lastKnockAt.delete(socket.id)
        socket.broadcast.emit('player-left', socket.id)

        // 访客中途掉线：撤掉请求并让主人的弹窗自己关掉
        for(const request of [ ...requests.values() ])
        {
            if(request.visitorId === socket.id)
            {
                clearRequest(request.id)
                io.sockets.sockets.get(request.ownerId)?.emit('knock-cancelled', { id: request.id })
            }
        }
    })
})

httpServer.listen(PORT, () =>
{
    console.log(`Multiplayer server running on port ${PORT}`)
})
