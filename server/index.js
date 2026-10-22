import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'

/**
 * 联机服务器（阶段 2：位置同步 + 门禁审批）
 *
 * 本地启动：npm run server（默认 3001，前端另跑 Vite 5173）
 * 线上部署：先 npm run build，再由本服务器同时托管 dist/（Render 等平台注入 PORT）
 * 这样页面和 WebSocket 同源，前端无需配置 VITE_MULTIPLAYER_URL。
 *
 * 门禁审批：
 *   · 访客右键敲门 → knock
 *   · 服务器按 shared/plots.json 的 ownerName 找在线主人 → knock-request（只发给主人窗口）
 *   · 主人 Accept / Reject → knock-response
 *   · 服务器把结果告诉访客（knock-result），并广播门状态（gate-state）
 * 门「开 / 关」只认服务器广播，客户端不能自己开。
 *
 * 额外补充（方案里没写但必须有的两处）：
 *   · knock-sent：告诉访客「请求已送到」，避免敲门后没有任何反馈
 *   · gate-set：主人直接开门 / 门内的人出去时，也要走服务器广播，否则各窗口状态会不一致
 *   · 30 秒后自动关门：联机时客户端不再各自计时，否则两个窗口会互相把关掉
 */

const PORT = Number(process.env.PORT) || Number(process.env.MULTIPLAYER_PORT) || 3001

// 地块归属：与前端共用同一份数据
const plots = JSON.parse(readFileSync(new URL('../shared/plots.json', import.meta.url), 'utf8'))
const plotsById = new Map(plots.map((plot) => [ plot.id, plot ]))

const KNOCK_TIMEOUT = 30 * 1000        // 主人多久没响应就自动判为拒绝
const KNOCK_COOLDOWN = 3 * 1000        // 同一访客两次敲门的最小间隔
const GATE_OPEN_DURATION = 30 * 1000   // 门开多久后自动关上

/* ---------------------------------------------------------------------- *
 *  静态文件：线上用同一个端口把 dist/ 发出去，页面与 WebSocket 同源
 * ---------------------------------------------------------------------- */

const distPath = fileURLToPath(new URL('../dist', import.meta.url))

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm',
    '.glb': 'model/gltf-binary',
    '.ktx': 'image/ktx',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
}

function serveFile(_filePath, _request, _response)
{
    const extension = extname(_filePath).toLowerCase()
    const headers = { 'Content-Type': MIME_TYPES[extension] || 'application/octet-stream' }

    // Vite 产出的 assets 带 hash，可以长缓存；其余保持不缓存，方便重新部署后立刻生效
    headers['Cache-Control'] = _filePath.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'

    headers['Content-Length'] = statSync(_filePath).size
    _response.writeHead(200, headers)

    if(_request.method === 'HEAD')
        return _response.end()

    createReadStream(_filePath).pipe(_response)
}

function handleRequest(_request, _response)
{
    if(_request.method !== 'GET' && _request.method !== 'HEAD')
    {
        _response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
        return _response.end('Method not allowed\n')
    }

    const url = new URL(_request.url, 'http://localhost')

    if(url.pathname === '/health')
    {
        _response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        return _response.end('ok\n')
    }

    let pathname
    try
    {
        pathname = decodeURIComponent(url.pathname)
    }
    catch(error)
    {
        _response.writeHead(400)
        return _response.end()
    }

    if(pathname === '/')
        pathname = '/index.html'

    const filePath = normalize(join(distPath, pathname))
    const isInsideDist = filePath === distPath || filePath.startsWith(distPath + sep)

    if(isInsideDist && existsSync(filePath) && statSync(filePath).isFile())
        return serveFile(filePath, _request, _response)

    // 其余路径回落到前端入口（游戏是单页）
    const indexPath = join(distPath, 'index.html')

    if(existsSync(indexPath))
        return serveFile(indexPath, _request, _response)

    _response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return _response.end('Not built yet: run "npm run build" first\n')
}

const httpServer = createServer(handleRequest)

const io = new Server(httpServer, {
    cors: { origin: process.env.PUBLIC_ORIGIN || '*' },
})

// socket.id -> { id, name, position, rotationY }
const players = new Map()

// plotId -> { isOpen, pending: { visitorId, timer } | null, closeTimer }
const gates = new Map()

// socket.id -> 上次敲门时间
const lastKnockAt = new Map()

function getGate(_plotId)
{
    if(!gates.has(_plotId))
        gates.set(_plotId, { isOpen: false, pending: null, closeTimer: null })

    return gates.get(_plotId)
}

// 主人身份 = 昵称与地块登记表的 ownerName 一致（不区分大小写）
function isOwner(_player, _plot)
{
    return !!(_plot && _plot.ownerName) &&
        _plot.ownerName.toLowerCase() === _player.name.toLowerCase()
}

function findOwnerId(_plot)
{
    for(const player of players.values())
    {
        if(isOwner(player, _plot))
            return player.id
    }

    return null
}

function isInsidePlot(_player, _plot)
{
    if(!_plot || !Array.isArray(_player.position))
        return false

    const x = _player.position[0]
    const z = _player.position[2]

    return x >= _plot.bounds.minX && x <= _plot.bounds.maxX &&
           z >= _plot.bounds.minZ && z <= _plot.bounds.maxZ
}

// 门状态由服务器统一下发：所有窗口看到的是同一扇门
function setGate(_plotId, _isOpen)
{
    const gate = getGate(_plotId)

    if(gate.closeTimer)
        clearTimeout(gate.closeTimer)

    gate.isOpen = _isOpen
    gate.closeTimer = _isOpen
        ? setTimeout(() => setGate(_plotId, false), GATE_OPEN_DURATION)
        : null

    io.emit('gate-state', { plotId: _plotId, isOpen: gate.isOpen })
}

// 撤掉挂起的审批请求（超时、主人断线、访客断线都走这里）
function clearPending(_plotId)
{
    const gate = getGate(_plotId)
    if(!gate.pending)
        return null

    clearTimeout(gate.pending.timer)
    const pending = gate.pending
    gate.pending = null

    return pending
}

// 新连上来的窗口补发当前门状态
function syncGates(_socket)
{
    for(const [ plotId, gate ] of gates)
        _socket.emit('gate-state', { plotId: plotId, isOpen: gate.isOpen })
}

io.on('connection', (socket) =>
{
    socket.on('join', (data) =>
    {
        const name = String(data?.name || 'Visitor').slice(0, 24)
        const existing = players.get(socket.id)

        if(existing)
        {
            // 游戏内换了账号：只更新昵称
            existing.name = name
            io.emit('players', [ ...players.values() ])
            syncGates(socket)
            return
        }

        const player = {
            id: socket.id,
            name: name,
            position: [ 0, 0, 0 ],
            rotationY: 0,
        }

        players.set(socket.id, player)

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
        if(isOwner(visitor, plot))
            return

        // 防连点
        const now = Date.now()
        if(now - (lastKnockAt.get(socket.id) || 0) < KNOCK_COOLDOWN)
            return
        lastKnockAt.set(socket.id, now)

        const gate = getGate(plot.id)

        // 同一块地同时只处理一个请求，避免主人连弹好几个窗
        if(gate.pending)
            return socket.emit('knock-result', { plotId: plot.id, approved: false, reason: 'busy' })

        const ownerId = findOwnerId(plot)
        const ownerSocket = ownerId ? io.sockets.sockets.get(ownerId) : null

        if(!ownerSocket)
            return socket.emit('knock-result', { plotId: plot.id, approved: false, reason: 'owner-offline' })

        gate.pending = {
            visitorId: socket.id,
            timer: setTimeout(() =>
            {
                clearPending(plot.id)
                io.sockets.sockets.get(socket.id)?.emit('knock-result', { plotId: plot.id, approved: false, reason: 'timeout' })
                io.sockets.sockets.get(ownerId)?.emit('knock-cancelled', { plotId: plot.id })
            }, KNOCK_TIMEOUT),
        }

        socket.emit('knock-sent', { plotId: plot.id })

        // 只有这块地的主人才收到审批请求
        ownerSocket.emit('knock-request', {
            plotId: plot.id,
            visitorId: visitor.id,
            visitorName: visitor.name,
        })
    })

    socket.on('knock-response', (data) =>
    {
        const responder = players.get(socket.id)
        const plot = plotsById.get(data?.plotId)
        if(!responder || !plot || !isOwner(responder, plot))
            return

        const gate = getGate(plot.id)
        const pending = gate.pending
        if(!pending || pending.visitorId !== data?.visitorId)
            return

        clearPending(plot.id)

        io.sockets.sockets.get(pending.visitorId)?.emit('knock-result', {
            plotId: plot.id,
            approved: !!data.approved,
        })

        if(data.approved)
            setGate(plot.id, true)
    })

    // 主人直接开关门 / 门内的人出去：同样走服务器广播
    socket.on('gate-set', (data) =>
    {
        const player = players.get(socket.id)
        const plot = plotsById.get(data?.plotId)
        if(!player || !plot)
            return

        if(!isOwner(player, plot) && !isInsidePlot(player, plot))
            return

        setGate(plot.id, !!data.isOpen)
    })

    socket.on('disconnect', () =>
    {
        players.delete(socket.id)
        lastKnockAt.delete(socket.id)
        socket.broadcast.emit('player-left', socket.id)

        // 访客中途掉线：撤掉请求，让主人的弹窗自己关掉
        for(const [ plotId, gate ] of gates)
        {
            if(gate.pending && gate.pending.visitorId === socket.id)
            {
                clearPending(plotId)
                io.sockets.sockets.get(findOwnerId(plotsById.get(plotId)))?.emit('knock-cancelled', { plotId: plotId })
            }
        }
    })

    socket.on('disconnecting', () =>
    {
        // 主人断线：把他在各地块上挂起的请求判为拒绝
        for(const [ plotId, gate ] of gates)
        {
            const plot = plotsById.get(plotId)
            if(!gate.pending || !plot)
                continue

            const player = players.get(socket.id)
            if(!player || !isOwner(player, plot))
                continue

            const pending = clearPending(plotId)
            io.sockets.sockets.get(pending.visitorId)?.emit('knock-result', {
                plotId: plotId,
                approved: false,
                reason: 'owner-offline',
            })
        }
    })
})

httpServer.listen(PORT, () =>
{
    console.log(`Multiplayer server running on port ${PORT}`)
})
