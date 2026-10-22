import plots from '../../shared/plots.json'

/**
 * 全地图地块登记表（唯一登记处）
 *
 * 每块地在这里登记一条记录，字段：
 *   id          唯一标识（账号系统与门禁用它判断「谁是哪块地的主人」）
 *   name        界面上显示的名字
 *   description 一句说明
 *   bounds      世界坐标下的矩形范围（与 Territory.js / 围栏 / 地图一致）
 *   ownerName   预定的主人昵称（归属的唯一真相，见下方说明）
 *
 * 归属规则：ownerName 是「谁拥有这块地」的唯一真相。谁的注册昵称与它一致
 * （不区分大小写），谁就是主人；昵称对不上任何地块的人仍可注册，只是成为访客。
 * 以后要给全班同学分地，把每块地的 ownerName 填成对应同学的昵称即可。
 *
 * 目前只登记了玩家手绘的那块（northwest）。
 */
// 数据本体在 shared/plots.json：Node 端（联机服务器）也要读同一份归属与边界，
// 放这里一份、服务器一份容易改漏，所以统一从共享文件导入。
//
// ⚠️ ownerName 填的是你（本项目的作者）自己的注册昵称，若昵称不是 Regina 就改那一行。
export const PLOTS = plots

export function getPlot(_id)
{
    return PLOTS.find((plot) => plot.id === _id) || null
}

// 某个世界坐标落在哪块地里（没落在任何地块上则返回 null）。
// 只做矩形范围判断、不涉及归属，地图跳转与门禁都用它。
export function getPlotAt(_coordinates)
{
    const x = _coordinates.x
    const z = typeof _coordinates.z !== 'undefined' ? _coordinates.z : _coordinates.y

    return PLOTS.find((plot) =>
        x > plot.bounds.minX && x < plot.bounds.maxX &&
        z > plot.bounds.minZ && z < plot.bounds.maxZ
    ) || null
}
