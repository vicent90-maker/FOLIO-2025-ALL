import { Game } from './Game.js'
import { getPlot } from './TerritoryRegistry.js'

/**
 * 玩家领地（纯数据，不产生任何视觉呈现）
 *
 * 范围不再写死在这里，而是从 TerritoryRegistry 取登记好的地块。
 * 代码写死的是 id 'northwest'，以后账号系统从服务端得知「你是谁的地主」时，
 * 这里改成按当前账号的归属去取即可。
 *
 * 该地块的东边界正是玩家在游戏地图上手绘的那条线（Map.worldToMap 换算而来）：
 *   x ≈ -37.2，z 从 -36.3（北端）到 -16.2（南端），领地取该线以西。
 */
export class Territory
{
    constructor()
    {
        this.game = Game.getInstance()

        // 手绘边界线（世界坐标，北 → 南两个端点）—— 仅作记录
        this.boundary = [
            { x: - 37.2, z: - 36.3 },
            { x: - 37.2, z: - 16.2 },
        ]

        // 地块来自登记表
        const plot = getPlot('northwest')
        this.id = plot.id
        this.name = plot.name
        this.bounds = plot.bounds
    }

    contains(_x, _z)
    {
        return (
            _x >= this.bounds.minX && _x <= this.bounds.maxX &&
            _z >= this.bounds.minZ && _z <= this.bounds.maxZ
        )
    }
}
