/**
 * dsh-connect-minimax — 浏览器端：设置页（登录态/积分/签到/模型）+ 输入框积分读数。
 * 结构沿用 trae 桥验证过的宿主惯例；所有注册失败都只降级，不影响宿主。
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-minimax',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;

    const name = 'dsh-connect-minimax-client';
    const inject = ['slots', 'locale'];
    const PLUGIN_ID = 'dsh-connect-minimax';
    const PROVIDER_ID = 'minimax-code';
    const USAGE_PATH = '/plugins/dsh-connect-minimax/usage';
    const CHECKIN_PATH = '/plugins/dsh-connect-minimax/checkin';
    const NAMESPACE = 'settings.minimax-code';

    const zh = {
      'page.title': 'MiniMax Code（免费额度）',
      'auth.signedIn': '已登录（桌面应用登录态）',
      'auth.notSignedIn': '未找到 MiniMax Code 登录：请打开 MiniMax Code 桌面应用并登录',
      'auth.expires': '令牌到期',
      'credits.title': '积分',
      'credits.remaining': '可用',
      'credits.granted': '累计获得',
      'credits.consumed': '已使用',
      'credits.expiresHint': '按获得时间 30 天有效，先到先用',
      'checkin.title': '每日签到',
      'checkin.today': '今日',
      'checkin.status.1': '未开始',
      'checkin.status.2': '可领取',
      'checkin.status.3': '已领取',
      'checkin.status.4': '不可用',
      'checkin.claimNow': '立即签到',
      'checkin.claimed': '已领取 +{points} 积分',
      'checkin.autoOn': '自动签到运行中（每日自动领取）',
      'checkin.autoError': '自动签到失败重试中',
      'models.title': '可用模型',
      'actions.refresh': '刷新',
      'state.loading': '加载中…',
      'state.error': '读取失败',
      'composer.credits': 'MiniMax 积分',
    };
    const en = {
      'page.title': 'MiniMax Code (free quota)',
      'auth.signedIn': 'Signed in via the MiniMax Code desktop app',
      'auth.notSignedIn': 'No MiniMax Code login found: open the MiniMax Code desktop app and sign in',
      'auth.expires': 'Token expires',
      'credits.title': 'Credits',
      'credits.remaining': 'Available',
      'credits.granted': 'Granted',
      'credits.consumed': 'Used',
      'credits.expiresHint': 'Valid 30 days from grant; earliest-expiring are used first',
      'checkin.title': 'Daily check-in',
      'checkin.today': 'Today',
      'checkin.status.1': 'Not started',
      'checkin.status.2': 'Claimable',
      'checkin.status.3': 'Claimed',
      'checkin.status.4': 'Unavailable',
      'checkin.claimNow': 'Check in now',
      'checkin.claimed': 'Claimed +{points} credits',
      'checkin.autoOn': 'Auto check-in running (claims daily)',
      'checkin.autoError': 'Auto check-in retrying after failures',
      'models.title': 'Available models',
      'actions.refresh': 'Refresh',
      'state.loading': 'Loading…',
      'state.error': 'Failed to load',
      'composer.credits': 'MiniMax credits',
    };

    // ── 数据获取 ──────────────────────────────────────────────────────────
    async function fetchUsage() {
      const response = await fetch(USAGE_PATH, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.ok !== true) throw new Error(payload?.error?.message ?? 'unknown error');
      return payload;
    }

    async function postCheckin() {
      const response = await fetch(CHECKIN_PATH, { method: 'POST', headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    function fmtCredits(value) {
      return Number(value ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtTime(ms) {
      if (!ms) return '—';
      try {
        return new Date(ms).toLocaleString();
      } catch {
        return '—';
      }
    }

    // ── 样式 ──────────────────────────────────────────────────────────────
    const css = `
.mm-card{border:1px solid var(--dsh-border,rgba(128,128,128,.25));border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.mm-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mm-title{font-weight:600;font-size:13px}
.mm-muted{opacity:.65;font-size:12px}
.mm-stat{display:flex;flex-direction:column;gap:2px;min-width:110px}
.mm-stat b{font-size:16px}
.mm-days{display:flex;gap:6px;flex-wrap:wrap}
.mm-day{border:1px solid var(--dsh-border,rgba(128,128,128,.25));border-radius:8px;padding:4px 8px;font-size:11px;text-align:center;min-width:52px}
.mm-day.today{border-color:#4f8cff}
.mm-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
.mm-btn{border:1px solid var(--dsh-border,rgba(128,128,128,.35));border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;background:transparent;color:inherit}
.mm-btn:disabled{opacity:.5;cursor:default}
.mm-models{display:flex;gap:6px;flex-wrap:wrap}
.mm-pill{border:1px solid var(--dsh-border,rgba(128,128,128,.25));border-radius:999px;padding:3px 10px;font-size:12px}
.mm-error{color:#d9480f;font-size:12px}
.mm-ok{color:#2f9e44;font-size:12px}
.mm-composer{font-size:12px;opacity:.85;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
`;
    let styleInjected = false;
    function injectStyle() {
      if (styleInjected) return;
      styleInjected = true;
      try {
        const style = document.createElement('style');
        style.dataset.source = 'dsh-connect-minimax';
        style.textContent = css;
        document.head.appendChild(style);
      } catch {
        /* 非 DOM 环境 */
      }
    }

    // ── 设置页卡片 ────────────────────────────────────────────────────────
    function UsageCard({ t }) {
      const [data, setData] = React.useState(undefined);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [lastClaim, setLastClaim] = React.useState(undefined);

      const load = React.useCallback(async () => {
        try {
          setError('');
          setData(await fetchUsage());
        } catch (e) {
          setError(String(e?.message ?? e));
        }
      }, []);
      React.useEffect(() => {
        load();
        const timer = setInterval(load, 5 * 60_000);
        return () => clearInterval(timer);
      }, [load]);

      const claim = async () => {
        setBusy(true);
        try {
          const result = await postCheckin();
          const r = result?.result ?? {};
          setLastClaim(r.claimed ? { points: r.points } : { already: true });
          await load();
        } catch (e) {
          setLastClaim({ error: String(e?.message ?? e) });
        } finally {
          setBusy(false);
        }
      };

      if (data === undefined && !error) return h('div', { className: 'mm-muted' }, t('state.loading'));
      const auth = data?.auth ?? {};
      const credits = data?.credits ?? {};
      const signin = data?.signin ?? {};
      const today = (signin.days ?? []).find((d) => d.isToday);
      const auto = signin.auto ?? {};
      const models = data?.models ?? [];

      return h('div', { className: 'mm-card' },
        h('div', { className: 'mm-row' },
          h('span', { className: 'mm-title' }, t('page.title')),
          h('span', { className: 'mm-row', style: { marginLeft: 'auto' } },
            h('button', { className: 'mm-btn', onClick: claim, disabled: busy || today?.status === 3 }, t('checkin.claimNow')),
            h('button', { className: 'mm-btn', onClick: load }, t('actions.refresh')),
          ),
        ),
        h('div', { className: auth.signedIn ? 'mm-ok' : 'mm-error' },
          auth.signedIn ? `${t('auth.signedIn')}（${auth.region || 'cn'}） · ${t('auth.expires')} ${fmtTime(auth.expiresAtMs)}` : (auth.error ? `${t('auth.notSignedIn')} · ${auth.error}` : t('auth.notSignedIn')),
        ),
        h('div', { className: 'mm-row' },
          h('span', { className: 'mm-title' }, t('credits.title')),
          h('span', { className: 'mm-stat' }, h('b', null, fmtCredits(credits.remaining)), h('span', { className: 'mm-muted' }, t('credits.remaining'))),
          h('span', { className: 'mm-stat' }, h('b', null, fmtCredits(credits.granted)), h('span', { className: 'mm-muted' }, t('credits.granted'))),
          h('span', { className: 'mm-stat' }, h('b', null, fmtCredits(credits.consumed)), h('span', { className: 'mm-muted' }, t('credits.consumed'))),
        ),
        h('div', { className: 'mm-muted' }, t('credits.expiresHint')),
        credits.error ? h('div', { className: 'mm-error' }, `${t('state.error')}: ${credits.error}`) : null,
        h('div', { className: 'mm-row' },
          h('span', { className: 'mm-title' }, t('checkin.title')),
          auto.status === 'claimed'
            ? h('span', { className: 'mm-ok' }, t('checkin.autoOn'))
            : (auto.failures > 0 ? h('span', { className: 'mm-error' }, `${t('checkin.autoError')}（${auto.failures}）`) : null),
          lastClaim?.claimed ? h('span', { className: 'mm-ok' }, t('checkin.claimed').replace('{points}', String(lastClaim.points ?? 0))) : null,
          lastClaim?.already ? h('span', { className: 'mm-muted' }, t('checkin.status.3')) : null,
          lastClaim?.error ? h('span', { className: 'mm-error' }, lastClaim.error) : null,
        ),
        h('div', { className: 'mm-days' },
          (signin.days ?? []).slice(0, 7).map((d) => h('span', { key: d.dayNo, className: `mm-day${d.isToday ? ' today' : ''}` },
            h('span', null,
              h('span', {
                className: 'mm-dot',
                style: { background: d.status === 3 ? '#2f9e44' : d.status === 2 ? '#f59f00' : 'rgba(128,128,128,.4)' },
              }),
              `${t('checkin.status.' + d.status)}`,
            ),
            h('div', { className: 'mm-muted' }, `D${d.dayNo} +${d.points}${d.bonusPoints ? `+${d.bonusPoints}` : ''}`),
          )),
        ),
        h('div', { className: 'mm-row' },
          h('span', { className: 'mm-title' }, t('models.title')),
          h('span', { className: 'mm-models' }, models.map((m) => h('span', { key: m.id, className: 'mm-pill' }, m.name || m.id))),
        ),
      );
    }

    // ── 输入框积分读数 ────────────────────────────────────────────────────
    function ComposerCredits({ t, useProjection }) {
      // Hooks 必须无条件先调用（provider 变化只是改渲染内容）。
      const [credits, setCredits] = React.useState(undefined);
      React.useEffect(() => {
        let alive = true;
        const load = () => {
          fetchUsage().then((payload) => {
            if (alive) setCredits(payload?.credits?.remaining);
          }).catch(() => {});
        };
        load();
        const timer = setInterval(load, 5 * 60_000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);
      // useProjection 由宿主经 slot 渲染器传入（缺席容忍，同 trae）。
      const projection = useProjection === undefined ? undefined : useProjection('modelSelection');
      const provider = (projection?.next ?? projection?.lastUsed)?.provider;
      if (provider !== PROVIDER_ID) return null;
      if (credits === undefined) return null;
      return h('span', { className: 'mm-composer', title: t('credits.expiresHint') },
        `${t('composer.credits')} ${fmtCredits(credits)}`,
      );
    }

    // ── 注册辅助 ──────────────────────────────────────────────────────────
    function safeRegisterSlot(ctx, describe, run) {
      try {
        const dispose = run();
        return typeof dispose === 'function' ? dispose : () => {};
      } catch (error) {
        console.error(`[dsh-connect-minimax] ${describe} failed (host unaffected):`, error);
        return () => {};
      }
    }

    function apply(ctx) {
      injectStyle();
      try {
        ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-connect-minimax: locale');
        const t = ctx.locale.bind(NAMESPACE);

        // 设置页（order 30 与 trae 同位段；图标缺失只是降级为默认齿轮）。
        safeRegisterSlot(ctx, 'settings section page', () => {
          const disposers = [];
          disposers.push(ctx.slots.register({
            name: 'settings.section',
            id: PLUGIN_ID,
            order: 30,
            label: () => t('page.title'),
            locale: NAMESPACE,
            inject: () => ({ t, surface: 'section' }),
          }, UsageCard));
          try {
            const iconSvg = 'data:image/svg+xml;utf8,' + encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">'
              + '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>'
              + '<path d="M8 12.5l2.5 2.5L16 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            );
            const Icon = (props) => h('img', { src: iconSvg, width: props?.size ?? 16, height: props?.size ?? 16, alt: '' });
            disposers.push(ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
              name: 'settings.section.icon',
              id: PLUGIN_ID,
              locale: NAMESPACE,
            }, Icon)));
          } catch (error) {
            console.error('[dsh-connect-minimax] settings icon failed (page unaffected):', error);
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                /* 已回收 */
              }
            }
          };
        });

        // 输入框积分读数：双座位（同 trae），由组件按 provider 门控。
        // useProjection 不进 inject：宿主渲染 slot 时自动并入 props。
        const registerCreditsSeat = (slotName, id, order) => {
          safeRegisterSlot(ctx, `credits slot "${slotName}"`, () => ctx.slots.register({
            name: slotName,
            id,
            order,
            locale: NAMESPACE,
            inject: () => ({ t }),
          }, ComposerCredits));
        };
        registerCreditsSeat('conversation.input.right', 'dsh-connect-minimax-composer-credits', 4);
        registerCreditsSeat('conversation.composer.dock', 'dsh-connect-minimax-dock-credits', 10);
      } catch (error) {
        console.error('[dsh-connect-minimax] client card failed to load (host unaffected):', error);
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
