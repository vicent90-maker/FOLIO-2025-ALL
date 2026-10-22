import * as THREE from 'three/webgpu'
import { io } from 'socket.io-client'
import { Game } from './Game.js'

/**
 * 联机 · 阶段 1：玩家位置同步
 *
 * 只同步"人"，不同步场景。每 50ms 把自己的位置发给服务器，
 * 收到别人的位置后画一个简易小车并平滑移动过去。
 * 账号、门禁审批等后续阶段再往这里加。
 */
export class Networking
{
    constructor()
    {
        this.game = Game.getInstance()

        this.players = new Map()
        this.sendInterval = 50
        this.lastName = null
        this.lastPlotId = null

        // 局域网测试时，别人打开 http://192.168.x.x:5173，
        // 这里会自动连到同一台机器上的 3001 端口
        const url = import.meta.env.VITE_MULTIPLAYER_URL || `${location.protocol}//${location.hostname}:3001`
        this.socket = io(url, { transports: [ 'websocket' ] })

        this.socket.on('connect', () => this.join())
        this.socket.on('players', (list) => list.forEach((item) => this.addPlayer(item)))
        this.socket.on('player-joined', (item) => this.addPlayer(item))
        this.socket.on('player-left', (id) => this.removePlayer(id))
        this.socket.on('player-moved', (item) => this.movePlayer(item))

        // 门禁审批：服务器只把审批请求发给地块主人，门状态也由服务器统一广播
        this.socket.on('knock-sent', (data) => this.game.territoryFence?.onKnockSent(data))
        this.socket.on('knock-request', (data) => this.game.territoryFence?.onKnockRequest(data))
        this.socket.on('knock-cancelled', (data) => this.game.territoryFence?.onKnockCancelled(data))
        this.socket.on('knock-result', (data) => this.game.territoryFence?.onKnockResult(data))
        this.socket.on('gate-state', (data) => this.game.territoryFence?.onGateState(data))

        this.game.ticker.events.on('tick', () => this.update(), 11)

        // 位置发送不走游戏循环：窗口切到后台时游戏循环会暂停，
        // 用定时器至少能保持低频同步，不至于让别人看到自己完全卡死
        this.sendTimer = setInterval(() => this.sendPosition(), this.sendInterval)
    }

    get name()
    {
        const user = this.game.accounts.getCurrentUser()

        return user ? user.name : 'Visitor'
    }

    // 当前账号名下的地块：服务器据此知道"谁是这块地的主人，该把审批请求发给谁"
    get plotId()
    {
        const ownedPlots = this.game.accounts.getOwnedPlots()

        return ownedPlots.length > 0 ? ownedPlots[0].id : null
    }

    join()
    {
        this.lastName = this.name
        this.lastPlotId = this.plotId
        this.socket.emit('join', { name: this.lastName, plotId: this.lastPlotId })
    }

    update()
    {
        // 游戏内换了账号：重新报一次昵称与归属
        if(this.socket.connected && (this.name !== this.lastName || this.plotId !== this.lastPlotId))
            this.join()

        // 其他玩家平滑追赶目标位置，避免一跳一跳
        for(const player of this.players.values())
        {
            player.group.position.lerp(player.targetPosition, 0.25)
            player.group.rotation.y = player.targetRotationY
        }
    }

    sendPosition()
    {
        if(!this.socket.connected)
            return

        this.socket.emit('move', {
            position: [ this.game.player.position.x, this.game.player.position.y, this.game.player.position.z ],
            rotationY: this.game.player.rotationY,
        })
    }

    addPlayer(data)
    {
        if(!data || data.id === this.socket.id || this.players.has(data.id))
            return

        // 用 socket id 生成一个稳定的颜色，方便区分不同的人
        let hash = 0
        for(const character of data.id)
            hash += character.charCodeAt(0)

        const color = new THREE.Color().setHSL((hash % 12) / 12, 0.65, 0.55)

        // fog 关掉：场景有雾，远处的人会被雾吃掉，联机调试时很难确认对方在哪
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, fog: false })
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 3.2), material)
        mesh.castShadow = true
        mesh.position.set(...data.position)

        this.game.scene.add(mesh)

        this.players.set(data.id, {
            group: mesh,
            targetPosition: new THREE.Vector3(...data.position),
            targetRotationY: Math.PI / 2 - data.rotationY,
        })
    }

    movePlayer(data)
    {
        const player = this.players.get(data.id)
        if(!player || !Array.isArray(data.position))
            return

        player.targetPosition.set(...data.position)
        player.targetRotationY = Math.PI / 2 - data.rotationY
    }

    removePlayer(id)
    {
        const player = this.players.get(id)
        if(!player)
            return

        this.game.scene.remove(player.group)
        player.group.geometry.dispose()
        player.group.material.dispose()
        this.players.delete(id)
    }
}
