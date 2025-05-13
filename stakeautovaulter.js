// ==UserScript==
// @name         Stake Auto-Vault Utility
// @version      0.61-beta
// @description  Automatically sends a percentage of your profits to the vault, works on stake.com, its mirror sites, and stake.us
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
    const SAVE_AMOUNT = 0.04; // 4% of profit
    const BIG_WIN_THRESHOLD = 5; // 5x balance = big win
    const BIG_WIN_MULTIPLIER = 10; // Save 10x more on big win
    const DISPLAY_VAULT_TOTAL = true;
    const CHECK_INTERVAL = 5000;
    const INIT_DELAY = 7000;
    const DEFAULT_CURRENCY = 'bnb';
    const DEFAULT_US_CURRENCY = 'sc';

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

    // --- Simplified selectors ---
    const BALANCE_SELECTOR = isStakeUS
        ? '[data-testid="user-balance"] .numeric, .numeric.variant-highlighted'
        : '[data-testid="user-balance"], .balance-value, .navigation .balance-toggle .currency span.content span';

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
                return res.json();
            } catch (e) {
                log('API call failed:', e);
                return null;
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

    // --- Vault Display UI ---
    class VaultDisplay {
        constructor() {
            this._el = document.createElement("span");
            this._el.id = "vaultDisplayElement";
            this._el.innerText = "0.00000000";
            this._el.title = "Deposited to vault";
            Object.assign(this._el.style, {
                marginLeft: "10px",
                color: "#00c4a7",
                fontSize: "0.9em"
            });
            this.insert();
            if (DISPLAY_VAULT_TOTAL) this.updateVaultBalance();
        }
        insert() {
            const tryInsert = () => {
                const targets = [
                    '[data-testid="user-balance"]',
                    '.navigation .balance-toggle .currency',
                    '.styles__UserBalance-sc-x5c1sz-4',
                    '.wallet-info'
                ];
                for (const sel of targets) {
                    const t = document.querySelector(sel);
                    if (t && !document.getElementById('vaultDisplayElement')) {
                        t.appendChild(this._el);
                        return true;
                    }
                }
                return false;
            };
            if (!tryInsert()) {
                const obs = new MutationObserver((_, o) => {
                    if (tryInsert()) o.disconnect();
                });
                obs.observe(document.body, {childList: true, subtree: true});
            }
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
        if (getCurrency.cached) return getCurrency.cached;
        // 1. Try any element with data-active-currency
        const el = document.querySelector('[data-active-currency]');
        if (el) {
            const c = el.getAttribute('data-active-currency');
            if (c) return getCurrency.cached = c.toLowerCase();
        }
        // 2. Stake.US: fallback to default
        if (isStakeUS) return getCurrency.cached = DEFAULT_US_CURRENCY;
        // 3. .com: fallback to default
        return getCurrency.cached = DEFAULT_CURRENCY;
    }

    // --- Get balance from UI ---
    function getCurrentBalance() {
        const el = document.querySelector(BALANCE_SELECTOR);
        if (el) {
            const txt = el.textContent.trim().replace(/[^\d.-]/g, '');
            const val = parseFloat(txt);
            if (!isNaN(val)) return val;
        }
        return 0;
    }

    // --- Main logic ---
    function initVaultScript() {
        if (isScriptInitialized) return;
        if (document.readyState !== 'complete') return setTimeout(initVaultScript, 1000);
        getCurrency.cached = null;
        isScriptInitialized = true;

        log(`Starting on ${hostname} (${isStakeUS ? 'Stake.us' : 'Stake.com'})`);
        log(`Currency: ${getCurrency()}`);

        const vaultDisplay = new VaultDisplay();
        const stakeApi = new StakeApi();

        let activeCurrency = getCurrency();
        let oldBalance = 0;
        let isProcessing = false;
        let isInitialized = false;
        let balanceChecks = 0;

        function checkCurrencyChange() {
            getCurrency.cached = null;
            const newCurrency = getCurrency();
            if (newCurrency !== activeCurrency) {
                log(`💱 Currency changed: ${activeCurrency} → ${newCurrency}`);
                activeCurrency = newCurrency;
                vaultDisplay.reset();
                updateCurrentBalance();
                isInitialized = false;
                balanceChecks = 0;
                return true;
            }
            return false;
        }

        function updateCurrentBalance() {
            const cur = getCurrentBalance();
            if (cur > 0) {
                oldBalance = cur;
                if (!isInitialized && balanceChecks++ >= 2) {
                    isInitialized = true;
                    log(`🐾 Initial balance: ${oldBalance.toFixed(8)} ${activeCurrency}`);
                }
            }
        }

        async function processDeposit(amount, isBigWin) {
            if (amount < 1e-8 || isProcessing) return;
            isProcessing = true;
            const curBal = getCurrentBalance();
            log(isBigWin
                ? `😸 BIG WIN! Saving ${(SAVE_AMOUNT*BIG_WIN_MULTIPLIER*100).toFixed(0)}%: ${amount.toFixed(8)} ${activeCurrency}`
                : `😺 Win! Saving ${(SAVE_AMOUNT*100).toFixed(0)}%: ${amount.toFixed(8)} ${activeCurrency}`
            );
            oldBalance = curBal - amount;
            try {
                const resp = await stakeApi.depositToVault(activeCurrency, amount);
                isProcessing = false;
                if (resp && resp.data && resp.data.createVaultDeposit) {
                    vaultDisplay.update(amount);
                    log(`✓ Saved ${amount.toFixed(8)} ${activeCurrency} to vault!`);
                } else {
                    log('✗ Deposit failed, will retry.', resp);
                    oldBalance = curBal;
                }
            } catch (e) {
                isProcessing = false;
                log('Vault deposit error:', e);
                oldBalance = curBal;
            }
        }

        function initializeBalance() {
            updateCurrentBalance();
            let tries = 0, maxTries = 5;
            const intv = setInterval(() => {
                updateCurrentBalance();
                if (++tries >= maxTries) {
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

        function checkBalanceChanges() {
            if (checkCurrencyChange()) return;
            const cur = getCurrentBalance();
            if (!isInitialized) return updateCurrentBalance();
            if (cur > oldBalance) {
                const profit = cur - oldBalance;
                const isBig = cur > oldBalance * BIG_WIN_THRESHOLD;
                const depAmt = profit * SAVE_AMOUNT * (isBig ? BIG_WIN_MULTIPLIER : 1);
                processDeposit(depAmt, isBig);
            } else if (cur < oldBalance) {
                oldBalance = cur;
            }
        }

        initializeBalance();
        setInterval(checkBalanceChanges, CHECK_INTERVAL);
    }

    setTimeout(initVaultScript, INIT_DELAY);
})();