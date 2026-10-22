import { Game } from './Game.js'
import { PLOTS } from './TerritoryRegistry.js'

/**
 * 本地版账号系统（P1 的前身）
 *
 * ⚠️ 安全边界：数据存在浏览器 localStorage，任何人都能用开发者工具改写，
 * 所以这套只能用于本地演示与交互验证。真正上线时必须把这一层换成服务端接口：
 *   · load / save → 换成对服务端的读写（或干脆不再本地留存，只留会话令牌）
 *   · register    → 换成 POST /register（加盐与哈希在服务端完成）
 *   · login       → 换成 POST /login（服务端返回会话令牌）
 * 地块归属由 TerritoryRegistry 里每块地的 ownerName 决定，服务端版改为服务端裁决。
 * 其余查询方法（ownsPlot / getPlotOwner / getOwnedPlots / getCurrentUser / isLoggedIn）
 * 换成服务端版后，改为读取服务端返回的会话与归属数据即可。
 *
 * 代码分两层，替换时只需动数据层：
 *   · 数据层：load / save / hashPassword / register / login / logout
 *   · 界面层：setDom 及其下所有事件回调（登录 / 注册覆盖层与 HUD）
 *
 * 存储结构（localStorage key = folio2025.accounts）：
 *   {
 *     users: [ { id, name, salt, hash, createdAt } ],
 *     session: userId | null,       // 当前登录的人
 *   }
 * salt 与 hash 都是 base64；密码本身从不落盘。
 *
 * 归属规则：TerritoryRegistry.PLOTS 中每块地的 ownerName 是唯一真相。
 * 谁的昵称与该字段一致（不区分大小写），谁就是那块地的主人；
 * 昵称对不上任何地块的人仍然可以注册，只是成为「访客（没有地）」。
 */
export class Accounts
{
    static STORAGE_KEY = 'folio2025.accounts'

    // PBKDF2 迭代次数：越高越难暴力破解，但登录时算得越久
    static ITERATIONS = 150000

    constructor()
    {
        this.game = Game.getInstance()

        this.onAuthenticated = null

        this.load()
        this.setDom()
        this.refresh()
    }

    /* ------------------------------------------------------------------ *
     *  数据层
     * ------------------------------------------------------------------ */

    load()
    {
        let data = null

        try
        {
            const raw = localStorage.getItem(Accounts.STORAGE_KEY)
            data = raw ? JSON.parse(raw) : null
        }
        catch(error)
        {
            data = null
        }

        // 容错：localStorage 里没有、或内容被改坏了，都回退成一份空数据
        if(!data || typeof data !== 'object')
            data = {}

        this.data = {
            users: Array.isArray(data.users) ? data.users : [],
            session: (typeof data.session === 'string') ? data.session : null,
        }
    }

    save()
    {
        try
        {
            localStorage.setItem(Accounts.STORAGE_KEY, JSON.stringify(this.data))
        }
        catch(error)
        {
            // 无痕模式等场景下写不进去，忽略即可（本次会话仍可用）
        }
    }

    toBase64(_bytes)
    {
        let string = ''
        for(const byte of _bytes)
            string += String.fromCharCode(byte)

        return btoa(string)
    }

    fromBase64(_string)
    {
        const string = atob(_string)
        const bytes = new Uint8Array(string.length)

        for(let i = 0; i < string.length; i++)
            bytes[i] = string.charCodeAt(i)

        return bytes
    }

    randomSalt()
    {
        const bytes = new Uint8Array(16)
        crypto.getRandomValues(bytes)

        return bytes
    }

    async hashPassword(_password, _salt)
    {
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(_password),
            'PBKDF2',
            false,
            [ 'deriveBits' ]
        )

        const bits = await crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: _salt,
                iterations: Accounts.ITERATIONS,
                hash: 'SHA-256',
            },
            keyMaterial,
            256
        )

        return this.toBase64(new Uint8Array(bits))
    }

    // 注册即完成：地块归属不需要额外绑定，由昵称与 PLOTS.ownerName 自动匹配
    async register(_name, _password)
    {
        const name = String(_name || '').trim()
        const password = String(_password || '')

        if(name.length < 2)
            throw new Error('The nickname needs at least 2 characters')
        if(password.length < 4)
            throw new Error('The password needs at least 4 characters')
        if(this.data.users.find((user) => user.name.toLowerCase() === name.toLowerCase()))
            throw new Error('This nickname is already taken')

        const salt = this.randomSalt()
        const hash = await this.hashPassword(password, salt)

        const user = {
            id: typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `u${Date.now()}${Math.round(Math.random() * 1e6)}`,
            name: name,
            salt: this.toBase64(salt),
            hash: hash,
            createdAt: Date.now(),
        }

        this.data.users.push(user)
        this.data.session = user.id
        this.save()
        this.refresh()

        return user
    }

    async login(_name, _password)
    {
        const name = String(_name || '').trim()
        const user = this.data.users.find((item) => item.name.toLowerCase() === name.toLowerCase())

        if(!user)
            throw new Error('No account with this nickname')

        const hash = await this.hashPassword(String(_password || ''), this.fromBase64(user.salt))
        if(hash !== user.hash)
            throw new Error('Wrong password')

        this.data.session = user.id
        this.save()
        this.refresh()

        return user
    }

    logout()
    {
        this.data.session = null
        this.save()
        this.refresh()
    }

    /* ------------------------------------------------------------------ *
     *  查询
     * ------------------------------------------------------------------ */

    getCurrentUser()
    {
        if(!this.data.session)
            return null

        return this.data.users.find((user) => user.id === this.data.session) || null
    }

    isLoggedIn()
    {
        return this.getCurrentUser() !== null
    }

    // 某块地现在的主人是哪个用户（没有登记主人、或主人还没注册时返回 null）
    getPlotOwner(_plotId)
    {
        const plot = PLOTS.find((item) => item.id === _plotId)
        if(!plot || !plot.ownerName)
            return null

        const ownerName = plot.ownerName.toLowerCase()

        return this.data.users.find((user) => user.name.toLowerCase() === ownerName) || null
    }

    ownsPlot(_plotId)
    {
        const user = this.getCurrentUser()
        if(!user)
            return false

        const plot = PLOTS.find((item) => item.id === _plotId)
        if(!plot || !plot.ownerName)
            return false

        return plot.ownerName.toLowerCase() === user.name.toLowerCase()
    }

    // 当前登录的人名下所有地块（HUD 用它显示身份）
    getOwnedPlots()
    {
        const user = this.getCurrentUser()
        if(!user)
            return []

        const name = user.name.toLowerCase()

        return PLOTS.filter((plot) => plot.ownerName && plot.ownerName.toLowerCase() === name)
    }

    /* ------------------------------------------------------------------ *
     *  界面层
     * ------------------------------------------------------------------ */

    setDom()
    {
        this.element = this.game.domElement.querySelector('.js-auth')
        this.hudElement = this.game.domElement.querySelector('.js-auth-hud')
        this.logoutElement = this.game.domElement.querySelector('.js-auth-logout')

        this.panels = Array.from(this.element.querySelectorAll('.js-auth-panel'))

        // 登录表单
        const loginForm = this.element.querySelector('.js-auth-form[data-name="login"]')
        loginForm.addEventListener('submit', (event) =>
        {
            event.preventDefault()

            this.submit(async () =>
            {
                await this.login(
                    loginForm.querySelector('.js-login-name').value,
                    loginForm.querySelector('.js-login-password').value
                )

                this.close()
            }, loginForm)
        })

        // 注册表单：一步到位（昵称 + 密码），地块按昵称自动认领，不用再挑
        const registerForm = this.element.querySelector('.js-auth-form[data-name="register"]')
        registerForm.addEventListener('submit', (event) =>
        {
            event.preventDefault()

            this.submit(async () =>
            {
                await this.register(
                    registerForm.querySelector('.js-register-name').value,
                    registerForm.querySelector('.js-register-password').value
                )

                this.close()
            }, registerForm)
        })

        // 面板切换（登录 ⇄ 注册）
        for(const button of this.element.querySelectorAll('.js-auth-switch'))
        {
            button.addEventListener('click', () =>
            {
                this.switchPanel(button.dataset.target)
            })
        }

        if(this.hudElement)
        {
            // HUD：点击 = 弹出登出确认（不直接登出，避免误触）
            this.hudElement.addEventListener('click', () =>
            {
                this.openLogoutConfirm()
            })
        }

        if(this.logoutElement)
        {
            this.logoutElement.querySelector('.js-auth-logout-confirm').addEventListener('click', () =>
            {
                this.closeLogoutConfirm()
                this.logout()

                // 不重载整个游戏，直接回到登录层
                this.open()
            })

            this.logoutElement.querySelector('.js-auth-logout-cancel').addEventListener('click', () =>
            {
                this.closeLogoutConfirm()
            })
        }
    }

    open(_onAuthenticated = null)
    {
        this.onAuthenticated = _onAuthenticated

        this.switchPanel('login')

        this.element.classList.add('is-visible')

        // 阻断游戏输入（与弹窗打开时的做法一致）
        this.game.inputs.filters.clear()
        this.game.inputs.filters.add('modal')

        const focus = this.element.querySelector('.js-auth-panel.is-active .js-auth-input')
        if(focus)
            focus.focus()
    }

    close()
    {
        this.element.classList.remove('is-visible')

        const callback = this.onAuthenticated
        this.onAuthenticated = null

        if(typeof callback === 'function')
            callback()
        else
        {
            // 从游戏内登出后再登录的情形（open 没带回调）：直接把输入还给走路
            this.game.inputs.filters.clear()
            this.game.inputs.filters.add('wandering')

            // 换了身份就送回出生点：否则主人进门后改用访客登录，会直接站在别人领地里
            if(this.game.reveal.step >= 2)
            {
                this.game.player.respawn(this.game.respawns.defaultName, () =>
                {
                    this.game.view.focusPoint.isTracking = true
                })
            }
        }
    }

    openLogoutConfirm()
    {
        if(!this.logoutElement)
            return

        this.logoutElement.classList.add('is-visible')

        this.game.inputs.filters.clear()
        this.game.inputs.filters.add('modal')
    }

    closeLogoutConfirm()
    {
        if(!this.logoutElement)
            return

        this.logoutElement.classList.remove('is-visible')

        this.game.inputs.filters.clear()
        this.game.inputs.filters.add('wandering')
    }

    switchPanel(_name)
    {
        for(const panel of this.panels)
            panel.classList.toggle('is-active', panel.dataset.name === _name)

        const focus = this.element.querySelector('.js-auth-panel.is-active .js-auth-input')
        if(focus)
            focus.focus()
    }

    setError(_element, _message)
    {
        const errorElement = _element.querySelector('.js-auth-error')
        errorElement.textContent = _message
    }

    clearErrors()
    {
        for(const errorElement of this.element.querySelectorAll('.js-auth-error'))
            errorElement.textContent = ''
    }

    // 统一处理「异步提交 + 出错显示 + 按钮禁用」，避免每个表单各写一遍
    async submit(_action, _element)
    {
        this.clearErrors()
        this.toggleButtons(_element, true)

        try
        {
            await _action()
        }
        catch(error)
        {
            this.setError(_element, error.message)
        }
        finally
        {
            this.toggleButtons(_element, false)
        }
    }

    toggleButtons(_element, _disabled)
    {
        for(const button of _element.querySelectorAll('.button'))
            button.classList.toggle('is-disabled', _disabled)
    }

    // 每次登录状态变化都刷新一遍界面
    refresh()
    {
        if(!this.hudElement)
            return

        const user = this.getCurrentUser()

        if(user)
        {
            const ownedPlots = this.getOwnedPlots()
            const identity = ownedPlots.length > 0 ? `${ownedPlots[0].name}'s owner` : 'Visitor (no land)'

            // 两行：第一行昵称，第二行身份
            this.hudElement.innerHTML = /* html */`
                <span class="name">${user.name}</span>
                <span class="identity">${identity}</span>
            `
            this.hudElement.classList.add('is-visible')
        }
        else
        {
            this.hudElement.innerHTML = ''
            this.hudElement.classList.remove('is-visible')
        }
    }
}
