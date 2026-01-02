// ==UserScript==
// @name         Stake Auto-Vault Utility (Floaty UI)
// @version      0.9-improved
// @description  Automatically sends a percentage of your profits to the vault, works on stake.com, its mirror sites, and stake.us. Now with floaty draggable UI, config persistence, touch support, and improved reliability!
// @author       by Ruby, courtesy of Stake Stats; original code framework by Christopher Hummel
// @website      https://stakestats.net/
// @homepage     https://feli.fyi/
// @match        https://stake.com/*
// @match        https://stake.bet/*
// @match        https://stake.games/*
// @match        https://staketr.com/*
// @match        https://staketr2.com/*
// @match        https://staketr3.com/*
// @match        https://staketr4.com/*
// @match        https://stake.bz/*
// @match        https://stake.us/*
// @match        https://stake.pet/*
// @run-at       document-end
// @namespace    Stake Auto-Vault Utility
// ==/UserScript==

(function() {
    'use strict';

    // --- Config ---
    const INIT_DELAY = 4000;
    const DEFAULT_CURRENCY = 'bnb';
    const DEFAULT_US_CURRENCY = 'sc';
    const MIN_BALANCE_CHECKS = 2;
    const DEPOSIT_VAULT_PERCENTAGE = 0.2;
    const CURRENCY_CACHE_TIMEOUT = 5000;
    const BALANCE_INIT_RETRIES = 5;
    const RATE_LIMIT_MAX = 50;
    const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

    // Load config from localStorage or use defaults
    function loadConfig() {
        const saved = localStorage.getItem('autovault-config');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                log('Failed to load saved config:', e);
            }
        }
        return {
            saveAmount: 0.1,
            bigWinThreshold: 5,
            bigWinMultiplier: 3,
            displayVaultTotal: true,
            checkInterval: 90000
        };
    }

    function saveConfig(config) {
        localStorage.setItem('autovault-config', JSON.stringify(config));
    }

    let config = loadConfig();
    let SAVE_AMOUNT = config.saveAmount;
    let BIG_WIN_THRESHOLD = config.bigWinThreshold;
    let BIG_WIN_MULTIPLIER = config.bigWinMultiplier;
    let DISPLAY_VAULT_TOTAL = config.displayVaultTotal;
    let CHECK_INTERVAL = config.checkInterval;

    // --- Site detection ---
    const hostname = window.location.hostname;
    const isStakeUS = hostname.endsWith('.us');
    let isScriptInitialized = false;

    // --- Logging helper ---
    const log = (...args) => console.log('[AutoVault]', ...args);

    // --- Cookie helper ---
    const getCookie = (name) => {
        const m = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
        return m ? m.pop().replace(/"/g, '') : '';
    };

    // --- Balance selectors (updated for current Stake DOM structure) ---
    // Primary: coin-toggle button contains balance in .content span
    // Fallbacks included for potential variations
    const BALANCE_SELECTORS = [
        '[data-testid="coin-toggle"] .content span[data-ds-text="true"]',
        '[data-testid="balance-toggle"] .content span[data-ds-text="true"]',
        '[data-testid="coin-toggle"] .content span',
        '[data-testid="balance-toggle"] span.content span',
        // Legacy selectors as final fallback
        '[data-testid="user-balance"] .numeric',
        '.numeric.variant-highlighted',
        '[data-testid="user-balance"]',
        '.balance-value'
    ];

    // --- Stake API ---
    class StakeApi {
        constructor() {
            this.apiUrl = window.location.origin + '/_api/graphql';
            this._accessToken = getCookie("session");
            this.headers = {
                'content-type': 'application/json',
                'x-access-token': this._accessToken,
                'x-language': 'en'
            };
        }
        async call(body, opName) {
            const headers = {...this.headers};
            if (opName) headers['x-operation-name'] = opName;
            try {
                const res = await fetch(this.apiUrl, {
                    credentials: 'include',
                    headers,
                    referrer: window.location.origin,
                    body: body,
                    method: 'POST',
                    mode: 'cors',
                    cache: 'no-cache'
                });
                if (!res.ok) {
                    log(`API call failed with status ${res.status}: ${res.statusText}`);
                    return { error: true, status: res.status, message: res.statusText };
                }
                return res.json();
            } catch (e) {
                log('API call failed:', e);
                return { error: true, message: e.message, type: 'network' };
            }
        }
        async getBalances() {
            const q = {
                query: `query UserBalances {
                    user { id balances {
                        available { amount currency }
                        vault { amount currency }
                    }}}`,
                variables: {}
            };
            return this.call(JSON.stringify(q), 'UserBalances');
        }
        async depositToVault(currency, amount) {
            const q = {
                query: `mutation CreateVaultDeposit($currency: CurrencyEnum!, $amount: Float!) {
                    createVaultDeposit(currency: $currency, amount: $amount) {
                        id amount currency user {
                            id balances {
                                available { amount currency }
                                vault { amount currency }
                            }
                        }
                        __typename
                    }
                }`,
                variables: { currency, amount }
            };
            return this.call(JSON.stringify(q), 'CreateVaultDeposit');
        }
    }

    // --- Vault Display UI (floaty) ---
    class VaultDisplay {
        constructor() {
            this._el = document.createElement("span");
            this._el.id = "vaultDisplayElement";
            this._el.innerText = "0.00000000";
            this._el.title = "Deposited to vault";
            Object.assign(this._el.style, {
                marginLeft: "8px",
                color: "#00c4a7",
                fontSize: "1em",
                fontWeight: "bold",
                background: "#1a2c38",
                borderRadius: "6px",
                padding: "2px 8px",
                boxShadow: "0 2px 8px #0002"
            });
            // Instead of inserting into nav, floaty UI will show this in the widget
        }
        async updateVaultBalance() {
            const api = new StakeApi();
            const resp = await api.getBalances();
            if (resp && resp.data && resp.data.user) {
                const curr = getCurrency();
                const bal = resp.data.user.balances.find(x =>
                    x.vault.currency.toLowerCase() === curr
                );
                if (bal) this._el.innerText = (+bal.vault.amount).toFixed(8);
            }
        }
        update(amount) {
            if (DISPLAY_VAULT_TOTAL) this.updateVaultBalance();
            else {
                const cur = parseFloat(this._el.innerText) || 0;
                this._el.innerText = (cur + amount).toFixed(8);
            }
        }
        reset() {
            if (DISPLAY_VAULT_TOTAL) this.updateVaultBalance();
            else this._el.innerText = "0.00000000";
        }
    }

    // --- Simplified currency detection ---
    function getCurrency() {
        const now = Date.now();
        if (getCurrency.cached && getCurrency.cacheTime && (now - getCurrency.cacheTime < CURRENCY_CACHE_TIMEOUT)) {
            return getCurrency.cached;
        }
        const el = document.querySelector('[data-active-currency]');
        if (el) {
            const c = el.getAttribute('data-active-currency');
            if (c) {
                getCurrency.cached = c.toLowerCase();
                getCurrency.cacheTime = now;
                return getCurrency.cached;
            }
        }
        const defaultCurr = isStakeUS ? DEFAULT_US_CURRENCY : DEFAULT_CURRENCY;
        getCurrency.cached = defaultCurr;
        getCurrency.cacheTime = now;
        return defaultCurr;
    }

    // --- Get balance from UI ---
    function getCurrentBalance() {
        // Try each selector in order until we find a valid balance
        for (const selector of BALANCE_SELECTORS) {
            try {
                const el = document.querySelector(selector);
                if (el) {
                    const txt = el.textContent.trim().replace(/[^\d.-]/g, '');
                    const val = parseFloat(txt);
                    if (!isNaN(val) && val >= 0) {
                        // Cache the working selector for performance
                        if (!getCurrentBalance._workingSelector || getCurrentBalance._workingSelector !== selector) {
                            getCurrentBalance._workingSelector = selector;
                            log(`📍 Balance detected using selector: ${selector}`);
                        }
                        getCurrentBalance.lastKnownBalance = val;
                        return val;
                    }
                }
            } catch (e) {
                // Continue to next selector
            }
        }
        // If no selector worked, log a warning (but only once per session)
        if (!getCurrentBalance._warned) {
            getCurrentBalance._warned = true;
            log('⚠️ Could not detect balance with any known selector. Please check if Stake updated their UI.');
        }
        return getCurrentBalance.lastKnownBalance || 0;
    }

    // --- Vault Rate Limit Tracking ---
    function loadRateLimitData() {
        const saved = sessionStorage.getItem('autovault-ratelimit');
        if (saved) {
            try {
                const data = JSON.parse(saved);
                return data.filter(ts => Date.now() - ts < RATE_LIMIT_WINDOW);
            } catch (e) {
                log('Failed to load rate limit data:', e);
            }
        }
        return [];
    }

    function saveRateLimitData(timestamps) {
        sessionStorage.setItem('autovault-ratelimit', JSON.stringify(timestamps));
    }

    let vaultActionTimestamps = loadRateLimitData();

    function canVaultNow() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        saveRateLimitData(vaultActionTimestamps);
        return vaultActionTimestamps.length < RATE_LIMIT_MAX;
    }

    function getVaultCountLastHour() {
        const now = Date.now();
        vaultActionTimestamps = vaultActionTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
        return vaultActionTimestamps.length;
    }

    // --- Floaty UI Widget ---
    function createVaultFloatyUI(startCallback, stopCallback, getParams, setParams, vaultDisplay) {
        // Remove old if present
        if (document.getElementById('autovault-floaty')) {
            document.getElementById('autovault-floaty').remove();
        }

        // Style
        const style = document.createElement('style');
        style.textContent = `
        #autovault-floaty {
            background: rgba(34,56,74,0.98);
            color: #b1bad3;
            border: 1.5px solid #00c4a7;
            border-radius: 13px;
            box-shadow: 0 8px 32px #000a, 0 1.5px 0 #00c4a7;
            font-family: proxima-nova, sans-serif;
            font-size: 15px;
            min-width: 270px;
            max-width: 350px;
            padding: 0 0 8px 0;
            user-select: none;
            position: fixed;
            top: 32px;
            right: 32px;
            z-index: 999999;
            display: flex;
            flex-direction: column;
            align-items: stretch;
            transition: box-shadow 0.2s, background 0.2s;
        }
        #autovault-floaty .autovault-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: linear-gradient(90deg,#00c4a7 60%,#ab5893 100%);
            color: #1a2c38;
            padding: 10px 18px 10px 16px;
            border-radius: 13px 13px 0 0;
            font-weight: bold;
            letter-spacing: 0.5px;
            font-size: 1.1em;
            box-shadow: 0 2px 8px #0002;
            cursor: grab;
            position: relative;
        }
        #autovault-floaty .autovault-close {
            position: absolute;
            top: 7px;
            right: 12px;
            font-size: 20px;
            color: #ab5893;
            background: none;
            border: none;
            cursor: pointer;
            font-weight: bold;
            z-index: 10;
        }
        #autovault-floaty .autovault-close:hover {
            color: #fff;
        }
        #autovault-floaty .autovault-content {
            padding: 18px 20px 10px 20px;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        #autovault-floaty label {
            display: flex;
            align-items: center;
            font-size: 15px;
            margin-bottom: 0;
            gap: 8px;
        }
        #autovault-floaty input[type="number"] {
            background: #1a2c38;
            color: #b1bad3;
            border: 1px solid #2e4157;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 15px;
            width: 70px;
        }
        #autovault-floaty .autovault-btn {
            background: linear-gradient(90deg,#00c4a7 60%,#ab5893 100%);
            color: #1a2c38;
            border: none;
            border-radius: 7px;
            padding: 7px 18px;
            font-weight: bold;
            cursor: pointer;
            margin-right: 8px;
            box-shadow: 0 2px 8px #0002;
            transition: background 0.2s, color 0.2s;
        }
        #autovault-floaty .autovault-btn:hover {
            background: linear-gradient(90deg,#ab5893 60%,#00c4a7 100%);
            color: #fff;
        }
        #autovault-floaty .autovault-vaultcount {
            display: inline-block;
            margin-left: 8px;
            font-size: 13px;
            color: #00c4a7;
            background: #1a2c38;
            border-radius: 7px;
            padding: 2px 10px;
            font-weight: bold;
            vertical-align: middle;
            box-shadow: 0 1px 4px #0002;
        }
        #autovault-floaty .autovault-help {
            position: absolute;
            bottom: 10px;
            right: 10px;
            width: 30px;
            height: 30px;
            background: #00c4a7;
            color: #1a2c38;
            border: none;
            border-radius: 50%;
            font-size: 19px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 2px 8px #0002;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 100001;
            transition: background 0.2s, color 0.2s;
        }
        #autovault-floaty .autovault-help:hover {
            background: #ab5893;
            color: #fff;
        }
        @media (max-width: 700px) {
            #autovault-floaty {
                left: 50% !important;
                top: 10px !important;
                min-width: 90vw !important;
                max-width: 98vw !important;
                right: auto !important;
                transform: translateX(-50%) !important;
            }
        }
        `;
        document.head.appendChild(style);

        // Widget container
        const widget = document.createElement('div');
        widget.id = 'autovault-floaty';

        // Header
        const header = document.createElement('div');
        header.className = 'autovault-header';
        header.innerHTML = `<span style="display:flex;align-items:center;gap:8px;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style="margin-right:2px;"><circle cx="12" cy="12" r="10" fill="#00c4a7"/><path d="M8 12l2 2 4-4" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            AutoVault
        </span>`;
        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'autovault-close';
        closeBtn.title = 'Close';
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => widget.remove();
        header.appendChild(closeBtn);
        widget.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.className = 'autovault-content';

        // Controls
        const saveLabel = document.createElement('label');
        saveLabel.innerHTML = `Save %: <input id="vaultSaveAmount" type="number" min="0" max="1" step="0.01" value="${getParams().saveAmount}">`;

        const bigWinLabel = document.createElement('label');
        bigWinLabel.innerHTML = `Big Win Threshold: <input id="vaultBigWinThreshold" type="number" min="1" step="0.1" value="${getParams().bigWinThreshold}">`;

        const intervalLabel = document.createElement('label');
        intervalLabel.innerHTML = `Check Interval (sec): <input id="vaultCheckInterval" type="number" min="10" step="1" value="${getParams().checkInterval}">`;

        // Start/Stop buttons
        const btnRow = document.createElement('div');
        btnRow.style.margin = "10px 0 0 0";
        btnRow.style.display = "flex";
        btnRow.style.gap = "10px";
        const startBtn = document.createElement('button');
        startBtn.className = 'autovault-btn';
        startBtn.id = 'vaultStartBtn';
        startBtn.textContent = 'Start';
        const stopBtn = document.createElement('button');
        stopBtn.className = 'autovault-btn';
        stopBtn.id = 'vaultStopBtn';
        stopBtn.textContent = 'Stop';
        stopBtn.disabled = true;
        btnRow.appendChild(startBtn);
        btnRow.appendChild(stopBtn);

        // Status
        const statusRow = document.createElement('div');
        statusRow.style.fontSize = "13px";
        statusRow.style.opacity = "0.8";
        statusRow.innerHTML = `<span id="vaultStatusText">Status: <b>Stopped</b></span> <span id="vaultVaultCount" class="autovault-vaultcount"></span>`;

        // Vault balance display
        const vaultBalRow = document.createElement('div');
        vaultBalRow.style.fontSize = "13px";
        vaultBalRow.style.marginTop = "2px";
        vaultBalRow.style.display = "flex";
        vaultBalRow.style.alignItems = "center";
        vaultBalRow.innerHTML = `<span style="color:#00c4a7;font-weight:bold;">Vault:</span> `;
        vaultBalRow.appendChild(vaultDisplay._el);

        // Help button
        const helpBtn = document.createElement('button');
        helpBtn.className = 'autovault-help';
        helpBtn.title = 'Help / About';
        helpBtn.innerHTML = '?';

        // Help modal
        const helpModal = document.createElement('div');
        helpModal.id = 'autovault-help-modal';
        helpModal.style.display = 'none';
        helpModal.style.position = 'fixed';
        helpModal.style.zIndex = '100002';
        helpModal.style.left = '0'; helpModal.style.top = '0'; helpModal.style.right = '0'; helpModal.style.bottom = '0';
        helpModal.style.background = 'rgba(0,0,0,0.45)';
        helpModal.innerHTML = `
            <div style="background:#22384a;color:#b1bad3;border:2px solid #ab5893;border-radius:14px;max-width:370px;margin:80px auto;padding:28px 28px 18px 28px;box-shadow:0 8px 32px #000a;position:relative;font-size:15px;">
                <button class="closeHelpBtn" title="Close" style="position:absolute;top:10px;right:14px;background:none;border:none;color:#ab5893;font-size:22px;font-weight:bold;cursor:pointer;">&times;</button>
                <h2 style="margin-top:0;color:#00c4a7;font-size:1.3em;">Stake Auto-Vault Utility</h2>
                <div>
                    <b>Author:</b> Ruby<br>
                    <b>Contact:</b> <a href="https://stakestats.net/" target="_blank" style="color:#00c4a7;">stakestats.net</a><br>
                    <b>Homepage:</b> <a href="https://feli.fyi/" target="_blank" style="color:#00c4a7;">feli.fyi</a><br>
                    <b>Version:</b> 0.9-improved
                </div>
                <hr style="margin:14px 0 10px 0; border:0; border-top:1px solid #2e4157;">
                <div>
                    <b>What does this do?</b><br>
                    This script automatically sends a percentage of your profits to your Stake vault.<br>
                    <ul style="margin:8px 0 0 18px; padding:0;">
                        <li>Works on stake.com, stake.us, and mirror sites</li>
                        <li>Settings persist across page reloads</li>
                        <li>Touch support for mobile devices</li>
                        <li>Improved error handling and reliability</li>
                        <li>Open source, no data leaves your browser</li>
                        <li>Vault actions are rate limited to 50 per hour (Stake API limit)</li>
                    </ul>
                </div>
                <div style="margin-top:18px;font-size:13px;color:#888;text-align:right;">
                    &copy; 2024 Ruby / Stake Stats
                </div>
            </div>
        `;
        document.body.appendChild(helpModal);

        helpBtn.onclick = function(e) {
            e.stopPropagation();
            helpModal.style.display = 'block';
        };
        helpModal.querySelector('.closeHelpBtn').onclick = function(e) {
            e.stopPropagation();
            helpModal.style.display = 'none';
        };
        helpModal.onclick = function(e) {
            if (e.target === helpModal) helpModal.style.display = 'none';
        };

        // Add to content
        content.appendChild(saveLabel);
        content.appendChild(bigWinLabel);
        content.appendChild(intervalLabel);
        content.appendChild(btnRow);
        content.appendChild(statusRow);
        content.appendChild(vaultBalRow);

        widget.appendChild(content);
        widget.appendChild(helpBtn);

        // Drag logic with proper cleanup and touch support
        let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

        const mouseMoveHandler = function(e) {
            if (!isDragging) return;
            let newLeft = e.clientX - dragOffsetX;
            let newTop = e.clientY - dragOffsetY;
            // Clamp to viewport
            newLeft = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, newTop));
            widget.style.left = newLeft + 'px';
            widget.style.top = newTop + 'px';
            widget.style.right = 'auto';
            widget.style.transform = '';
        };

        const mouseUpHandler = function() {
            if (isDragging) {
                isDragging = false;
                widget.style.cursor = 'grab';
                widget.style.boxShadow = '0 8px 32px #000a, 0 1.5px 0 #00c4a7';
            }
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
            document.removeEventListener('touchmove', touchMoveHandler);
            document.removeEventListener('touchend', touchEndHandler);
        };

        const touchMoveHandler = function(e) {
            if (!isDragging || !e.touches[0]) return;
            e.preventDefault();
            let newLeft = e.touches[0].clientX - dragOffsetX;
            let newTop = e.touches[0].clientY - dragOffsetY;
            newLeft = Math.max(0, Math.min(window.innerWidth - widget.offsetWidth, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - widget.offsetHeight, newTop));
            widget.style.left = newLeft + 'px';
            widget.style.top = newTop + 'px';
            widget.style.right = 'auto';
            widget.style.transform = '';
        };

        const touchEndHandler = function() {
            if (isDragging) {
                isDragging = false;
                widget.style.cursor = 'grab';
                widget.style.boxShadow = '0 8px 32px #000a, 0 1.5px 0 #00c4a7';
            }
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
            document.removeEventListener('touchmove', touchMoveHandler);
            document.removeEventListener('touchend', touchEndHandler);
        };

        header.addEventListener('mousedown', function(e) {
            if (e.target === closeBtn) return;
            isDragging = true;
            widget.style.cursor = 'grabbing';
            dragOffsetX = e.clientX - widget.getBoundingClientRect().left;
            dragOffsetY = e.clientY - widget.getBoundingClientRect().top;
            widget.style.boxShadow = '0 12px 32px #000c, 0 1.5px 0 #00c4a7';
            e.preventDefault();
            document.addEventListener('mousemove', mouseMoveHandler);
            document.addEventListener('mouseup', mouseUpHandler);
        });

        header.addEventListener('touchstart', function(e) {
            if (e.target === closeBtn || !e.touches[0]) return;
            isDragging = true;
            const touch = e.touches[0];
            dragOffsetX = touch.clientX - widget.getBoundingClientRect().left;
            dragOffsetY = touch.clientY - widget.getBoundingClientRect().top;
            widget.style.boxShadow = '0 12px 32px #000c, 0 1.5px 0 #00c4a7';
            document.addEventListener('touchmove', touchMoveHandler, { passive: false });
            document.addEventListener('touchend', touchEndHandler);
        });

        // Vault count UI update
        const vaultCountEl = content.querySelector('#vaultVaultCount');
        function updateVaultCountUI() {
            const count = getVaultCountLastHour();
            vaultCountEl.textContent = `Vaults: ${count}/${RATE_LIMIT_MAX} (last hour)`;
            if (count >= RATE_LIMIT_MAX) {
                vaultCountEl.style.color = "#ff4d4d";
                vaultCountEl.title = `You have reached the Stake API vault rate limit (${RATE_LIMIT_MAX} per hour).`;
            } else if (count >= RATE_LIMIT_MAX * 0.8) {
                vaultCountEl.style.color = "#ffae00";
                vaultCountEl.title = `Approaching Stake API vault rate limit (${RATE_LIMIT_MAX} per hour).`;
            } else {
                vaultCountEl.style.color = "#00c4a7";
                vaultCountEl.title = "Vault actions in the last hour.";
            }
        }
        window.__updateVaultCountUI = updateVaultCountUI;
        updateVaultCountUI();
        setInterval(updateVaultCountUI, 10000);

        // Start/Stop logic
        const statusText = content.querySelector('#vaultStatusText');
        startBtn.onclick = () => {
            startBtn.disabled = true;
            stopBtn.disabled = false;
            statusText.innerHTML = 'Status: <b style="color:#00c4a7">Running</b>';
            startCallback();
            updateVaultCountUI();
        };
        stopBtn.onclick = () => {
            startBtn.disabled = false;
            stopBtn.disabled = true;
            statusText.innerHTML = 'Status: <b>Stopped</b>';
            stopCallback();
            updateVaultCountUI();
        };

        // Parameter change logic
        content.querySelector('#vaultSaveAmount').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 0) v = 0;
            if (v > 1) v = 1;
            setParams({saveAmount: v});
            this.value = v;
        };
        content.querySelector('#vaultBigWinThreshold').onchange = function() {
            let v = parseFloat(this.value);
            if (isNaN(v) || v < 1) v = 1;
            setParams({bigWinThreshold: v});
            this.value = v;
        };
        content.querySelector('#vaultCheckInterval').onchange = function() {
            let v = parseInt(this.value, 10);
            if (isNaN(v) || v < 10) v = 10;
            setParams({checkInterval: v});
            this.value = v;
        };

        // Actually add to body (floaty, not in nav)
        document.body.appendChild(widget);

        // Expose UI update for status so the script can update the widget
        return {
            setStatus: (txt, color) => {
                statusText.innerHTML = `Status: <b style="color:${color||'#00c4a7'}">${txt}</b>`;
            },
            setRunning: (running) => {
                startBtn.disabled = running;
                stopBtn.disabled = !running;
            },
            updateVaultCount: updateVaultCountUI
        };
    }

    // --- Main logic ---
    let vaultInterval = null;
    let vaultDisplay = null;
    let stakeApi = null;
    let activeCurrency = null;
    let oldBalance = 0;
    let isProcessing = false;
    let isInitialized = false;
    let balanceChecks = 0;
    let lastDepositDetected = 0;
    let lastDepositAmount = 0;
    let lastBalance = 0;
    let lastVaultedDeposit = 0;
    let running = false;
    let uiWidget = null;

    function getParams() {
        return {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            checkInterval: Math.round(CHECK_INTERVAL/1000)
        };
    }
    function setParams(obj) {
        if (obj.saveAmount !== undefined) SAVE_AMOUNT = obj.saveAmount;
        if (obj.bigWinThreshold !== undefined) BIG_WIN_THRESHOLD = obj.bigWinThreshold;
        if (obj.checkInterval !== undefined) CHECK_INTERVAL = obj.checkInterval * 1000;

        // Save config to localStorage
        config = {
            saveAmount: SAVE_AMOUNT,
            bigWinThreshold: BIG_WIN_THRESHOLD,
            bigWinMultiplier: BIG_WIN_MULTIPLIER,
            displayVaultTotal: DISPLAY_VAULT_TOTAL,
            checkInterval: CHECK_INTERVAL
        };
        saveConfig(config);

        if (running) {
            stopVaultScript();
            startVaultScript();
        }
    }

    function checkCurrencyChange() {
        getCurrency.cached = null;
        getCurrency.cacheTime = null;
        const newCurrency = getCurrency();
        if (newCurrency !== activeCurrency) {
            log(`💱 Currency changed: ${activeCurrency} → ${newCurrency}`);
            activeCurrency = newCurrency;
            vaultDisplay.reset();
            isInitialized = false;
            balanceChecks = 0;
            updateCurrentBalance();
            return true;
        }
        return false;
    }

    function updateCurrentBalance() {
        const cur = getCurrentBalance();
        if (cur > 0) {
            oldBalance = cur;
            if (!isInitialized && balanceChecks++ >= MIN_BALANCE_CHECKS) {
                isInitialized = true;
                log(`🐾 Initial balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
            }
        }
    }

    // --- Vault Rate Limit Enforcement in processDeposit ---
    async function processDeposit(amount, isBigWin) {
        if (amount < 1e-8 || isProcessing) return;
        if (!canVaultNow()) {
            log(`✗ Vault action skipped: rate limit reached (${RATE_LIMIT_MAX} per hour).`);
            if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
            return;
        }
        isProcessing = true;
        log(isBigWin
            ? `😸 Fancy feast! Saving ${(SAVE_AMOUNT*BIG_WIN_MULTIPLIER*100).toFixed(0)}%: ${amount.toFixed(8)} ${activeCurrency}`
            : `😺 Positive balance difference detected! Saving ${(SAVE_AMOUNT*100).toFixed(0)}%: ${amount.toFixed(8)} ${activeCurrency}`
        );
        try {
            const resp = await stakeApi.depositToVault(activeCurrency, amount);
            isProcessing = false;
            if (resp && resp.data && resp.data.createVaultDeposit) {
                vaultDisplay.update(amount);
                vaultActionTimestamps.push(Date.now());
                saveRateLimitData(vaultActionTimestamps);
                // Re-read balance after successful deposit to avoid drift
                oldBalance = getCurrentBalance();
                if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
                log(`✓ Saved ${amount.toFixed(8)} ${activeCurrency} to vault!`);
            } else {
                log('✗ Deposit failed, you may be rate limited..', resp);
            }
        } catch (e) {
            isProcessing = false;
            log('Vault deposit error:', e);
        }
    }

    function initializeBalance() {
        updateCurrentBalance();
        let tries = 0;
        const intv = setInterval(() => {
            updateCurrentBalance();
            if (++tries >= BALANCE_INIT_RETRIES) {
                clearInterval(intv);
                if (oldBalance > 0) {
                    isInitialized = true;
                    log(`Initialized with starting balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
                } else {
                    log(`Unable to detect starting balance! Using current balance.`);
                    const cur = getCurrentBalance();
                    if (cur > 0) {
                        oldBalance = cur;
                        isInitialized = true;
                        log(`Last attempt balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
                    }
                }
            }
        }, 1000);
    }

    function detectDepositEvent() {
        let found = false;
        let depositAmount = 0;
        const possibleSelectors = [
            '[data-testid*="notification"]',
            '[class*="notification"]',
            '[class*="transaction"]',
            '[class*="history"]',
            '[class*="activity"]'
        ];
        for (const sel of possibleSelectors) {
            const nodes = document.querySelectorAll(sel);
            for (const node of nodes) {
                const txt = node.textContent.toLowerCase();
                if (txt.includes('deposit') && /\d/.test(txt)) {
                    const match = txt.match(/([\d,.]+)\s*[a-z]{2,4}/i);
                    if (match) {
                        depositAmount = parseFloat(match[1].replace(/,/g, ''));
                        if (!isNaN(depositAmount) && depositAmount > 0) {
                            found = true;
                            break;
                        }
                    }
                }
            }
            if (found) break;
        }
        if (found) {
            lastDepositDetected = Date.now();
            lastDepositAmount = depositAmount;
            return depositAmount;
        }
        return 0;
    }

    function checkBalanceChanges() {
        if (checkCurrencyChange()) return;
        const cur = getCurrentBalance();
        if (!isInitialized) return updateCurrentBalance();

        let depositAmt = detectDepositEvent();
        if (depositAmt > 0) {
            if (cur - lastBalance >= depositAmt * 0.95 && lastVaultedDeposit !== depositAmt) {
                const toVault = depositAmt * SAVE_AMOUNT;
                log(`💰 Detected deposit of ${depositAmt.toFixed(8)} ${activeCurrency}, vaulting ${(SAVE_AMOUNT * 100).toFixed(0)}% (${toVault.toFixed(8)})`);
                processDeposit(toVault, false);
                lastVaultedDeposit = depositAmt;
                oldBalance = cur;
            }
        } else if (cur > oldBalance) {
            const profit = cur - oldBalance;
            const isBig = cur > oldBalance * BIG_WIN_THRESHOLD;
            const depAmt = profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1);
            processDeposit(depAmt, isBig);
            oldBalance = cur;
        } else if (cur < oldBalance) {
            oldBalance = cur;
        }
        lastBalance = cur;
        if (uiWidget && typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
    }

    function startVaultScript() {
        if (running) return;
        isScriptInitialized = true;
        running = true;
        log(`AutoVault script started on ${hostname} (${isStakeUS ? 'Stake.us' : 'Stake.com'})`);
        log(`Currency: ${getCurrency()}`);
        vaultDisplay = new VaultDisplay();
             stakeApi = new StakeApi();
        activeCurrency = getCurrency();
        oldBalance = 0;
        isProcessing = false;
        isInitialized = false;
        balanceChecks = 0;
        lastDepositDetected = 0;
        lastDepositAmount = 0;
        lastBalance = getCurrentBalance();
        lastVaultedDeposit = 0;
        vaultActionTimestamps = [];
        initializeBalance();
        vaultInterval = setInterval(checkBalanceChanges, CHECK_INTERVAL);
        if (uiWidget) {
            uiWidget.setStatus('Running', '#00c4a7');
            uiWidget.setRunning(true);
            if (typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
        }
    }
    function stopVaultScript() {
        if (!running) return;
        running = false;
        isScriptInitialized = false;
        if (vaultInterval) clearInterval(vaultInterval);
        vaultInterval = null;
        if (uiWidget) {
            uiWidget.setStatus('Stopped', '#fff');
            uiWidget.setRunning(false);
            if (typeof uiWidget.updateVaultCount === "function") uiWidget.updateVaultCount();
        }
        log('AutoVault script stopped.');
    }

    // --- UI Widget setup (floaty) ---
    setTimeout(() => {
        if (!uiWidget) {
            vaultDisplay = new VaultDisplay();
            uiWidget = createVaultFloatyUI(
                startVaultScript,
                stopVaultScript,
                getParams,
                setParams,
                vaultDisplay
            );
        }
    }, INIT_DELAY);


})();