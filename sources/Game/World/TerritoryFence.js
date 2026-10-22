import * as THREE from 'three/webgpu'
import gsap from 'gsap'
import { Game } from '../Game.js'

// 门扇绕门轴旋转的轴（世界 Y 轴向上）
const UP_AXIS = new THREE.Vector3(0, 1, 0)

/**
 * 领地围栏：沿 Territory.bounds 的矩形四边逐段首尾拼接石栏板，把整块领地围起来，
 * 并在东边界留出一个可开关的大门。
 *
 * 资产 static/garden/stoneFence.glb（manifest key = stoneFence）经 process.js 归一化后为
 * 2 × 0.773 × 0.216 m，长度轴为局部 X、底面中心为原点，故按各边方向绕 Y 旋转后逐段摆放。
 *
 * 若某段查不到地面（地图边缘）或地面低于水面（海里），栏板改坐在 y = 0（水面之上），
 * 使整圈围栏首尾连续、且不会沉到水下。
 */
export class TerritoryFence
{
    constructor()
    {
        this.game = Game.getInstance()

        // 单段栏板长度，需与 manifest stoneFence 的 normalize.target 保持一致
        this.segmentLength = 2

        const bounds = this.game.territory.bounds
        const doorWidth = 6                    // 车辆连保险杠约 3m，留 6m 宽的车门
        const doorCenterZ = - 26               // 门洞中心（大致落在玩家手绘那条线的中段）

        // 门轴在门洞北端（z 更小 = 更靠北），门扇向南伸 6m
        const doorNorthZ = doorCenterZ - doorWidth * 0.5
        const doorSouthZ = doorCenterZ + doorWidth * 0.5

        this.gate = {
            x: bounds.maxX,
            northZ: doorNorthZ,
            southZ: doorSouthZ,
            width: doorWidth,
            center: { x: bounds.maxX, y: 0, z: doorCenterZ },
            group: null,
            visual: null,
            physical: null,
            angle: 0,            // 0 = 关；-PI/2 = 全开
            isOpen: false,
            isNearby: false,
            leavingTime: - 1,    // 玩家走远后的计时，-1 = 未触发
        }

        this.nearDistance = 8          // 走近多少米内出现提示
        this.autoCloseDistance = 15    // 走远多少米后开始计时
        this.autoCloseDelay = 2        // 计时多久自动关门

        // 主人端正在处理的那条敲门请求：{ plotId, visitorId }
        this.pendingKnock = null

        this.setGateInteractions()

        this.setFromBounds()

        this.game.ticker.events.on('tick', () =>
        {
            this.update()
        }, 9)
    }

    async setFromBounds()
    {
        const bounds = this.game.territory.bounds
        if(!bounds)
            return

        const compressed = !!import.meta.env.VITE_COMPRESSED
        const compressedSuffix = compressed ? '-compressed' : ''

        let resource = null
        try
        {
            const resources = await this.game.resourcesLoader.load([
                [ 'stoneFence', `garden/stoneFence${compressedSuffix}.glb?cb=1`, 'gltf' ]
            ])
            resource = resources.stoneFence
        }
        catch(error)
        {
            console.log(`TerritoryFence > Couldn't load stoneFence: ${error}`)
            return
        }

        if(!resource)
            return

        // 矩形四角，按顺时针首尾相连（北 → 东 → 南 → 西）
        const northWestCorner = { x: bounds.minX, z: bounds.minZ }
        const northEastCorner = { x: bounds.maxX, z: bounds.minZ }
        const southWestCorner = { x: bounds.minX, z: bounds.maxZ }
        const southEastCorner = { x: bounds.maxX, z: bounds.maxZ }

        // 东边被门洞切成南北两段，其余三边不变
        const edges = [
            [ northWestCorner, northEastCorner ],                                    // 北边
            [ northEastCorner, { x: bounds.maxX, z: this.gate.northZ } ],            // 东边（门洞以北）
            [ { x: bounds.maxX, z: this.gate.southZ }, southEastCorner ],            // 东边（门洞以南）
            [ southEastCorner, southWestCorner ],                                    // 南边
            [ southWestCorner, northWestCorner ],                                    // 西边
        ]

        for(const edge of edges)
            this.addEdge(edge[0], edge[1], resource)

        // 大门高度：与栏板同样的取地面规则
        let gateY = this.getGroundElevation(this.gate.x, this.gate.northZ)
        if(gateY === null || gateY < this.game.water.surfaceElevation)
            gateY = 0

        this.gate.center.y = gateY
        this.addGate(resource, gateY)
    }

    addEdge(_start, _end, _resource)
    {
        const directionX = _end.x - _start.x
        const directionZ = _end.z - _start.z
        const lineLength = Math.hypot(directionX, directionZ)

        // 按单段长度等分数，步长用实际等分长度（与 2m 的差可忽略），保证首尾相接
        const count = Math.max(1, Math.round(lineLength / this.segmentLength))
        const stepX = directionX / count
        const stepZ = directionZ / count

        // 绕 Y 旋转使栏板局部 +X（长度轴）对齐该边方向
        const rotation = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, Math.atan2(- directionZ, directionX), 0)
        )

        for(let i = 0; i < count; i++)
        {
            const x = _start.x + stepX * (i + 0.5)
            const z = _start.z + stepZ * (i + 0.5)
            let y = this.getGroundElevation(x, z)

            // 没有地面（地图边缘）或地面低于水面（在海里）：栏板改坐在 y = 0，
            // 与岸边陆地上的段落（y ≈ 0）平齐，整圈连续且不会沉到水下
            if(y === null || y < this.game.water.surfaceElevation)
                y = 0

            const model = _resource.scene.clone(true)
            model.quaternion.copy(rotation)
            model.position.set(x, y, z)

            // 模型名含 physical fixed，Objects 据此建 fixed 刚体
            const descriptions = this.game.objects.getFromModel(
                model,
                {},
                {
                    position: { x: x, y: y, z: z },
                    rotation: rotation,
                    sleeping: true
                }
            )

            // 用更高、更厚、且下探到地面以下的碰撞体，替换 GLB 自带的薄 cuboid：
            //  · 高到 y = 1.5m —— 车辆高速冲撞也翻不过去
            //  · 下探到 y = -0.5m —— 车头无法从栏板下方钻过
            //  · 厚 0.3m —— 降低高速穿透，且相邻两段在转角处互相咬合不留缝
            // 视觉上仍是一块 0.773m 高的石栏板
            descriptions[1].colliders = [
                {
                    shape: 'cuboid',
                    parameters: [ 1, 1, 0.15 ],
                    position: { x: 0, y: 0.5, z: 0 }
                }
            ]

            this.game.objects.add(...descriptions)
        }
    }

    addGate(_resource, _y)
    {
        // 门扇沿世界 +Z（向南）伸：每段栏板绕 Y 转 -90°，使局部 +X 对齐 +Z
        const segmentQuaternion = new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, - Math.PI * 0.5, 0)
        )

        // 门的原点 = 门轴（铰链），门扇从它向南排开，开门就是整个 group 绕门轴转
        const group = new THREE.Group()
        group.position.set(this.gate.x, _y, this.gate.northZ)

        const count = Math.max(1, Math.round(this.gate.width / this.segmentLength))
        for(let i = 0; i < count; i++)
        {
            const model = _resource.scene.clone(true)
            model.quaternion.copy(segmentQuaternion)
            model.position.set(0, 0, (i + 0.5) * this.segmentLength)
            group.add(model)
        }

        this.gate.group = group

        // 视觉单独注册（没有物理），门的旋转由下面的 update 直接驱动
        this.gate.visual = this.game.objects.add({ model: group })

        // 物理：独立刚体（不能与栏板共用，否则 setEnabled 会连带关掉旁边栏板留下缺口）
        //  · 固定刚体，碰撞盒从门轴向南伸满整扇门
        //  · 与栏板同样加高加厚并下探入地，避免车辆高速穿透
        //  · 关门 = setEnabled(true)；开门 = setEnabled(false)
        this.gate.physical = this.game.objects.add(null, {
            type: 'fixed',
            position: { x: this.gate.x, y: _y, z: this.gate.northZ },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            sleeping: true,
            colliders: [
                {
                    shape: 'cuboid',
                    parameters: [ 0.15, 1, this.gate.width * 0.5 ],
                    position: { x: 0, y: 0.5, z: this.gate.width * 0.5 }
                }
            ]
        })
    }

    setGateInteractions()
    {
        this.hintElement = this.game.domElement.querySelector('.js-gate-hint')
        this.gateModal = this.game.modals.items.get('gate')

        // 右键：项目的 Pointer 只有 Pointer.any（不分左右键），故直接监听原生 contextmenu。
        // Pointer 里已经 preventDefault，但事件仍会冒泡，所以这里能收到。
        this.game.domElement.addEventListener('contextmenu', (event) =>
        {
            if(!this.gate.isNearby || this.gateModal.isOpen)
                return

            event.preventDefault()
            this.knock()
        })

        // 审批按钮：结果发给服务器，由服务器广播门状态，所有人的窗口一起开/关
        this.gateModal.element.querySelector('.js-gate-accept').addEventListener('click', () =>
        {
            this.respondKnock(true)
            this.game.modals.close()
        })

        this.gateModal.element.querySelector('.js-gate-reject').addEventListener('click', () =>
        {
            this.respondKnock(false)
            this.game.modals.close()
        })

        this.gateModal.events.on('open', () =>
        {
            this.updateHint()
        })
        this.gateModal.events.on('close', () =>
        {
            // 直接叉掉弹窗 = 拒绝，别让访客一直干等
            this.respondKnock(false)
            this.updateHint()
        })
    }

    // 右键按下时做什么
    knock()
    {
        // 没有联机就没有主人可以审批，直接提示，不再自己弹窗给自己
        if(!this.socket())
            return this.game.notifications.show('<div class="top"><div class="title">Multiplayer server offline</div></div>', 'server-disconnected', 3)

        // 门开着：再按一次就关上
        if(this.gate.isOpen)
            return this.requestGate(false)

        // 主人，或已经在领地里面的人：直接开门，不走审批
        if(this.canOpenFreely())
            return this.requestGate(true)

        // 其余人：把请求发给服务器，由主人决定
        if(this.gateModal.isOpen)
            return

        this.socket().emit('knock', { plotId: this.game.territory.id })
    }

    socket()
    {
        const networking = this.game.networking

        if(!networking || !networking.socket || !networking.socket.connected)
            return null

        return networking.socket
    }

    isMultiplayer()
    {
        return this.socket() !== null
    }

    // 本机想开/关门：联机时交给服务器广播，离线时只影响本地
    requestGate(_open)
    {
        const socket = this.socket()

        if(!socket)
            return _open ? this.openGate() : this.closeGate()

        socket.emit('gate-set', { plotId: this.game.territory.id, isOpen: _open })
    }

    // ---- 联机事件（由 Networking 转发过来） ----

    // 服务器广播的门状态：所有窗口看到同一扇门
    onGateState(_data)
    {
        if(!_data || _data.plotId !== this.game.territory.id)
            return

        _data.isOpen ? this.openGate() : this.closeGate()
    }

    // 访客端：请求已送到主人那里
    onKnockSent()
    {
        this.game.notifications.show('<div class="top"><div class="title">Request sent</div><div class="text">Waiting for the owner to approve...</div></div>', 'server-connected', 4)
    }

    // 主人端：有人敲自己的门，弹审批
    onKnockRequest(_data)
    {
        if(!_data || _data.plotId !== this.game.territory.id)
            return

        // 只有这块地的主人能审批，其他人收到也不处理
        if(!this.game.accounts.ownsPlot(this.game.territory.id))
            return

        // 门本来就开着：直接放行，不用打断主人
        if(this.gate.isOpen)
            return this.respondKnock(true, _data)

        this.pendingKnock = { plotId: _data.plotId, visitorId: _data.visitorId }
        this.gateModal.element.querySelector('.js-gate-visitor').textContent = _data.visitorName || 'Someone'
        this.game.modals.open('gate')
    }

    onKnockCancelled(_data)
    {
        if(!_data || !this.pendingKnock || _data.plotId !== this.pendingKnock.plotId)
            return

        this.pendingKnock = null

        if(this.gateModal.isOpen)
            this.game.modals.close()
    }

    // 访客端：审批结果（门本身由 gate-state 广播驱动）
    onKnockResult(_data)
    {
        if(!_data || _data.plotId !== this.game.territory.id)
            return

        if(_data.approved)
            return this.game.notifications.show('<div class="top"><div class="title">Access granted</div></div>', 'server-connected', 3)

        const messages = {
            'owner-offline': 'The owner is offline',
            'timeout': 'The owner did not respond',
            'busy': 'Another visitor is already waiting',
        }

        this.game.notifications.show(`<div class="top"><div class="title">${messages[_data.reason] || 'Visit rejected'}</div></div>`, 'server-disconnected', 3)
    }

    // 主人答复：{ plotId, visitorId, approved }
    respondKnock(_approved, _request = null)
    {
        const request = _request || this.pendingKnock
        this.pendingKnock = null

        if(!request)
            return

        this.socket()?.emit('knock-response', {
            plotId: request.plotId,
            visitorId: request.visitorId,
            approved: _approved,
        })
    }

    canOpenFreely()
    {
        // 这块地的主人：进出都直接开门
        if(this.game.accounts.ownsPlot(this.game.territory.id))
            return true

        // 已经在领地里面的人（此前已被放行进来参观）：出去时不需要再审批一次
        // ⚠️ 临时规则：等 P3 的限时通行证做好后，应改成「持有有效通行证」
        const playerPosition = this.game.player.position
        return this.game.territory.contains(playerPosition.x, playerPosition.z)
    }

    openGate()
    {
        const gate = this.gate
        if(gate.isOpen)
            return

        gate.isOpen = true
        gate.leavingTime = - 1

        // 开门 = 关掉门的物理刚体
        if(gate.physical)
            gate.physical.physical.body.setEnabled(false)

        gsap.to(gate, { angle: - Math.PI * 0.5, duration: 1, ease: 'power2.inOut', overwrite: true })

        this.updateHint()
    }

    closeGate()
    {
        const gate = this.gate
        if(!gate.isOpen)
            return

        gate.isOpen = false
        gate.leavingTime = - 1

        gsap.to(gate, {
            angle: 0,
            duration: 1,
            ease: 'power2.inOut',
            overwrite: true,
            onComplete: () =>
            {
                // 门扇转回原位后再打开碰撞体，避免途中把门里的人卡住
                if(gate.physical && !gate.isOpen)
                    gate.physical.physical.body.setEnabled(true)
            }
        })

        this.updateHint()
    }

    update()
    {
        const gate = this.gate
        if(!gate.group)
            return

        // 门扇朝向：0 = 关（沿 +Z 挡住门洞）；-PI/2 = 全开（转进领地内侧）
        gate.group.quaternion.setFromAxisAngle(UP_AXIS, gate.angle)

        const playerPosition = this.game.player.position
        const distance = Math.hypot(playerPosition.x - gate.center.x, playerPosition.z - gate.center.z)

        // 走近 / 走远 => 切换提示
        const isNearby = distance < this.nearDistance
        if(isNearby !== gate.isNearby)
        {
            gate.isNearby = isNearby
            this.updateHint()
        }

        // 门开着且人已走远：计时 2 秒后自动关上（中途折返则重新计时）
        // 联机时由服务器统一计时，否则各窗口会互相把门关掉
        if(gate.isOpen && !this.isMultiplayer())
        {
            if(distance > this.autoCloseDistance)
            {
                gate.leavingTime = gate.leavingTime < 0 ? 0 : gate.leavingTime + this.game.ticker.delta

                if(gate.leavingTime >= this.autoCloseDelay)
                    this.closeGate()
            }
            else
            {
                gate.leavingTime = - 1
            }
        }
    }

    updateHint()
    {
        const gate = this.gate

        if(!gate.isNearby || this.gateModal.isOpen)
        {
            this.hintElement.classList.remove('is-visible')
            return
        }

        if(gate.isOpen)
            this.hintElement.textContent = 'Right-click to close the gate'
        else if(this.canOpenFreely())
            this.hintElement.textContent = 'Right-click to open the gate'
        else
            this.hintElement.textContent = 'Right-click to knock on the gate'

        this.hintElement.classList.add('is-visible')
    }

    getGroundElevation(_x, _z)
    {
        const startY = 50

        // 采样点正好落在地形边界（±96）时，竖直射线会擦不到 heightfield 而查不到地面。
        // 故把采样点向内收 0.5m（只影响取高度，栏板仍摆在原坐标 _x/_z）。
        const halfSize = this.game.terrain.size * 0.5
        const inset = 0.5
        const sampleX = Math.min(Math.max(_x, - halfSize + inset), halfSize - inset)
        const sampleZ = Math.min(Math.max(_z, - halfSize + inset), halfSize - inset)

        const ray = new this.game.RAPIER.Ray({ x: sampleX, y: startY, z: sampleZ }, { x: 0, y: - 1, z: 0 })

        // 只接受「地面」分类的碰撞体（heightfield 大地 + 地基），否则射线会打到边界线上
        // 的其它固定物件（场景装饰等）或已摆好的栏板顶面，导致栏板被架在半空
        const floorGroups = this.game.physics.categories.floor
        const hit = this.game.physics.world.castRay(
            ray, 100, true,
            undefined, undefined, undefined, undefined,
            (collider) => collider.collisionGroups() === floorGroups
        )

        return hit ? startY - hit.timeOfImpact : null
    }
}
