import { Game } from '../../Game.js'
import { AltarArea } from './AltarArea.js'
import { CookieArea } from './CookieArea.js'
import { LandingArea } from './LandingArea.js'
import { ProjectsArea } from './ProjectsArea.js'
import { LabArea } from './LabArea.js'
import { CareerArea } from './CareerArea.js'
import { SocialArea } from './SocialArea.js'
import { ToiletArea } from './ToiletArea.js'
import { BowlingArea } from './BowlingArea.js'
import { CircuitArea } from './CircuitArea.js'
import { BehindTheSceneArea } from './BehindTheSceneArea.js'
import { AchievementsArea } from './AchievementsArea.js'
import { TimeMachineArea } from './TimeMachineArea.js'
import { EasterArea } from './EasterArea.js'

export class Areas
{
    constructor()
    {
        this.game = Game.getInstance()

        const list = [
            [ 'achievements', AchievementsArea ],
            [ 'altar', AltarArea ],
            [ 'behindTheScene', BehindTheSceneArea ],
            [ 'bowling', BowlingArea ],
            [ 'career', CareerArea ],
            [ 'circuit', CircuitArea ],
            [ 'cookie', CookieArea ],
            [ 'lab', LabArea ],
            [ 'landing', LandingArea ],
            [ 'projects', ProjectsArea ],
            [ 'social', SocialArea ],
            [ 'toilet', ToiletArea ],
            [ 'timeMachine', TimeMachineArea ],
        ]

        const model = [...this.game.resources.areasModel.scene.children]

        // 场景布局微调：赛道跳台原本横跨领地东边界（世界 x ≈ -37.2），会和围栏卡在一起，
        // 这里在创建物理体与视觉之前先把整块跳台向东移出领地（约 10 米）
        const circuitModel = model.find((child) => child.name.startsWith('circuit'))
        if(circuitModel)
        {
            const jump = circuitModel.getObjectByName('jump')
            if(jump)
                jump.position.x += 10
        }
        
        for(const child of model)
        {
            for(const [ name, AreaClass ] of list)
            {
                if(child.name.startsWith(name))
                    this[name] = new AreaClass(child)
            }
        }

        // // Test how many areas are visible
        // this.game.ticker.events.on('tick', () =>
        // {
        //     let i = 0
        //     if(this.achievements.frustum.isIn)
        //         i++
        //     if(this.altar.frustum.isIn)
        //         i++
        //     if(this.behindTheScene.frustum.isIn)
        //         i++
        //     if(this.bowling.frustum.isIn)
        //         i++
        //     if(this.career.frustum.isIn)
        //         i++
        //     if(this.circuit.frustum.isIn)
        //         i++
        //     if(this.cookie.frustum.isIn)
        //         i++
        //     if(this.lab.frustum.isIn)
        //         i++
        //     if(this.landing.frustum.isIn)
        //         i++
        //     if(this.projects.frustum.isIn)
        //         i++
        //     if(this.social.frustum.isIn)
        //         i++
        //     if(this.toilet.frustum.isIn)
        //         i++

        //     console.log(i)
        // }, 6)
    }
}