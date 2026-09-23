const https = require('https');
const { query } = require('./db');
const { getSetting, logRun } = require('./settings');

// Process-wide cache for the live Hydrawise relay list — shared across
// every request and every HydrawiseClient instance (NOT per-instance).
// See _liveRelayMap() for why this matters: Hydrawise rate-limits their
// API, and re-fetching this on every page view/click was tripping it.
const _globalLiveCache = {
  data: null,      // { byRelayId, byPhysicalNumber } once successfully fetched
  fetchedAt: 0,     // Date.now() of the last successful fetch
  ttlMs: 60000,     // default 60s; overwritten from Hydrawise's own `nextpoll` once known
  promise: null,    // in-flight fetch, so concurrent callers share one request
};

/**
 * Thin wrapper around the Hydrawise REST API (v1.5).
 *
 * While the PHC-2400 controller is still tied to the previous owner's
 * Hydrawise account, this runs in MOCK MODE: every call is logged to
 * run_log and zone "status" is derived from that log, so the whole app
 * is fully usable end to end with realistic behavior.
 *
 * Once you have your own API key, paste it into Settings (admin) — mock
 * mode turns off automatically, no code changes needed.
 *
 * Real endpoints (Hydrawise REST API v1.5):
 *   GET statusschedule.php?api_key=...
 *   GET customerdetails.php?api_key=...&type=controllers
 *   GET setzone.php?api_key=...&action=run|stop|suspend&relay_id=...&custom=<seconds>
 */
class HydrawiseClient {
  static async create() {
    const mock = (await getSetting('mock_mode', '1')) === '1';
    const apiKey = await getSetting('hydrawise_api_key', '');
    const controllerSerial = await getSetting('controller_serial', '');
    const controllerId = await getSetting('hydrawise_controller_id', '');
    return new HydrawiseClient(mock, apiKey, controllerSerial, controllerId);
  }

  constructor(mock, apiKey, controllerSerial, controllerId) {
    this.mock = mock;
    this.apiKey = apiKey;
    this.controllerSerial = controllerSerial;
    this.controllerId = controllerId;
  }

  /**
   * Resolves the real Hydrawise cloud relay_id for a zone, needed for
   * every setzone.php command (run/stop/suspend/resume). An admin-set
   * "Hydrawise Relay ID" on the Zones page wins if present — this is
   * checked FIRST specifically so that, once found once, we never need
   * to call Hydrawise again just to resolve a zone's ID (their API asks
   * callers to wait ~60s between statusschedule.php polls, so re-looking
   * this up on every single Run/Stop/Suspend click risks hitting that
   * limit and silently falling back to the broken zone-number guess).
   * The first time we successfully resolve a zone's relay_id from the
   * live list, we persist it to that zone's row so all future commands
   * for this zone skip the live lookup entirely.
   */
  async relayId(zone) {
    if (zone.hydrawise_relay_id) return zone.hydrawise_relay_id;
    if (!this.mock && this.apiKey) {
      const live = await this._liveRelayMap();
      const relay = live && live.byPhysicalNumber.get(String(zone.number));
      if (relay) {
        const resolvedId = String(relay.relay_id);
        try {
          await query('UPDATE zones SET hydrawise_relay_id = $1 WHERE id = $2', [resolvedId, zone.id]);
          zone.hydrawise_relay_id = resolvedId; // keep in-memory zone object in sync too
        } catch (e) {
          console.error(`Failed to persist hydrawise_relay_id for zone ${zone.id}:`, e.message);
        }
        return resolvedId;
      }
    }
    return String(zone.number);
  }

  async runZone(zone, minutes, triggeredBy, programId = null) {
    const relayId = await this.relayId(zone);
    if (this.mock) {
      return this._mock(zone.id, programId, 'run', minutes, triggeredBy,
        `MOCK: would call setzone.php?action=run&relay_id=${relayId}&custom=${minutes * 60}`);
    }
    return this._real('setzone.php', { action: 'run', relay_id: relayId, period_id: 999, custom: minutes * 60 },
      zone.id, programId, 'run', minutes, triggeredBy);
  }

  async stopZone(zone, triggeredBy, programId = null) {
    const relayId = await this.relayId(zone);
    if (this.mock) {
      return this._mock(zone.id, programId, 'stop', null, triggeredBy,
        `MOCK: would call setzone.php?action=stop&relay_id=${relayId}`);
    }
    return this._real('setzone.php', { action: 'stop', relay_id: relayId },
      zone.id, programId, 'stop', null, triggeredBy);
  }

  /**
   * Reverted back to the ORIGINAL parameter formula (period_id-based)
   * after two failed guesses tonight based on an unrelated third-party
   * library's convention. Terrence's note that this worked correctly a
   * week ago (aside from the separate dual-scheduler conflict) means the
   * real regression is more likely the controller_id pinning we added
   * tonight — a confirmed, necessary change — not this formula, which
   * may have been fine all along. Testing that theory directly: same
   * period_id logic as before, now WITH the correct controller_id
   * included (which it never had a week ago, back when the account only
   * had one controller).
   */
  /**
   * Corrected against Hunter's OFFICIAL REST API v1.4 documentation
   * (not a third-party guess this time) — every prior version of this
   * code had these two parameters backwards. The real spec is explicit:
   *   period_id — ALWAYS the fixed value 999, for every action. It is
   *               never related to timing at all.
   *   custom    — for 'suspend', this IS the timing value: "the Unix
   *               time epoch to suspend the zone until" (in seconds).
   * Our code was putting the until-timestamp into period_id (which
   * should only ever be 999) and never sending custom at all — an
   * invalid combination Hydrawise apparently accepted without visibly
   * erroring, which is why every previous attempt reported "success"
   * while never actually taking effect.
   *
   * There's still no dedicated "resume" action in Hydrawise's real
   * vocabulary (only run/stop/suspend + their "all" variants) — but
   * given how suspend's custom value works, suspending a zone "until"
   * a timestamp in the immediate past should end any active suspension
   * right away, since Hydrawise would see it as already expired.
   */
  async suspendZone(zone, untilTs, triggeredBy) {
    const relayId = await this.relayId(zone);
    const untilIso = new Date(untilTs).toISOString();
    if (this.mock) {
      return this._mock(zone.id, null, 'suspend', null, triggeredBy, `until:${untilIso}`);
    }
    return this._real('setzone.php', { action: 'suspend', relay_id: relayId, period_id: 999, custom: Math.floor(untilTs / 1000) },
      zone.id, null, 'suspend', null, triggeredBy, `until:${untilIso}`);
  }

  async resumeZone(zone, triggeredBy) {
    const relayId = await this.relayId(zone);
    if (this.mock) {
      return this._mock(zone.id, null, 'resume', null, triggeredBy, 'MOCK resume');
    }
    return this._real('setzone.php', { action: 'suspend', relay_id: relayId, period_id: 999, custom: Math.floor(Date.now() / 1000) },
      zone.id, null, 'resume', null, triggeredBy);
  }

  /**
   * Current zone status. In live mode this checks the REAL Hydrawise
   * controller first (statusschedule.php) so a suspension made outside
   * this app — in the Hydrawise app itself, or left over from the
   * previous owner — actually shows up here instead of being silently
   * missed. Falls back to our own run_log if the zone isn't accepting
   * a `zone` object (older callers passing a bare id), the live call
   * fails, or we're in mock mode.
   */
  async zoneStatus(zoneOrId) {
    const zone = (zoneOrId && typeof zoneOrId === 'object') ? zoneOrId : null;
    const zoneId = zone ? zone.id : zoneOrId;

    if (!this.mock && this.apiKey && zone) {
      const live = await this._liveStatusFor(zone);
      if (live) return live;
      // live lookup failed (network/API error, or no matching relay) —
      // fall through to the local run_log-derived status below.
    }

    return this._localStatus(zoneId);
  }

  /**
   * Fetches statusschedule.php and caches the result PROCESS-WIDE (shared
   * across every request and every HydrawiseClient instance), not just
   * within one page load. Hydrawise's response includes a `nextpoll`
   * field telling callers how many seconds to wait before polling again
   * (60s was observed) — every page view or button click that re-fetched
   * this independently was burning through Hydrawise's rate limit fast
   * enough to get commands themselves throttled. This cache respects
   * that hint so the whole app makes at most one statusschedule.php call
   * per that interval, no matter how many pages/zones are being viewed.
   */
  async _liveRelayMap() {
    const now = Date.now();
    if (_globalLiveCache.data && now - _globalLiveCache.fetchedAt < _globalLiveCache.ttlMs) {
      return _globalLiveCache.data;
    }
    if (_globalLiveCache.promise) return _globalLiveCache.promise;

    _globalLiveCache.promise = (async () => {
      try {
        // NOTE: controller_id is included ONLY when explicitly set in
        // Settings (Hydrawise Controller ID — the internal cloud ID, NOT
        // the physical serial number printed on the unit; sending the
        // serial as controller_id makes the whole request fail with
        // "Controller not found"). This account briefly had 2-3
        // controllers on it at once (a duplicate created by mistake,
        // plus a second real unit still pending its own transfer), and
        // with controller_id omitted, Hydrawise has to pick one on its
        // own for every call — which appears to have silently defaulted
        // to the WRONG controller (a blank/unconfigured one) for a
        // while, making every real zone look "suspended" with identical
        // placeholder data that was never actually real. Once there's
        // more than one controller on the account, omitting this is no
        // longer safe — see listControllers() for how to find the
        // correct ID to paste into Settings.
        const params = { api_key: this.apiKey };
        if (this.controllerId) params.controller_id = this.controllerId;
        const usp = new URLSearchParams(params);
        const url = `https://api.hydrawise.com/api/v1/statusschedule.php?${usp.toString()}`;
        const raw = await fetchWithTimeout(url, 8000);
        let data;
        try {
          data = JSON.parse(raw);
        } catch (parseErr) {
          // Hydrawise returns plain text (not JSON) for some errors,
          // e.g. a rate-limit message like "Exceeded maximum...". Log it
          // clearly instead of throwing a confusing JSON-parse error.
          console.error('Hydrawise statusschedule.php returned non-JSON (likely rate-limited or an API error):', raw.slice(0, 200));
          return null;
        }
        if (!data || !Array.isArray(data.relays)) return null;

        // Respect Hydrawise's own polling guidance if present; otherwise
        // default to 60s. Floor of 30s so a malformed/tiny value can't
        // make us hammer the API.
        _globalLiveCache.ttlMs = Math.max(30, Number(data.nextpoll) || 60) * 1000;

        // Hydrawise's `relays` entries carry TWO different identifiers:
        //   relay_id — an internal cloud ID (large arbitrary number)
        //   relay    — the physical zone number on the controller (1-24 here)
        // Our zones normally only know the physical number, so index by
        // BOTH: relay_id for zones where an admin has explicitly filled
        // in "Hydrawise Relay ID" on the Zones page, and physical `relay`
        // number for everything else (the common case).
        const byRelayId = new Map();
        const byPhysicalNumber = new Map();
        for (const r of data.relays) {
          byRelayId.set(String(r.relay_id), r);
          if (r.relay != null) byPhysicalNumber.set(String(r.relay), r);
        }

        _globalLiveCache.data = { byRelayId, byPhysicalNumber };
        _globalLiveCache.fetchedAt = Date.now();
        return _globalLiveCache.data;
      } catch (e) {
        console.error('Hydrawise live status fetch failed:', e.message);
        return null;
      } finally {
        _globalLiveCache.promise = null;
      }
    })();
    return _globalLiveCache.promise;
  }

  async _liveStatusFor(zone) {
    // If WE just took an action on this zone very recently (Run or Stop
    // through this app), trust that immediately rather than waiting on
    // Hydrawise's cache — this is the main source of the "have to wait
    // a minute to see it update" delay. The live cache only refreshes
    // roughly once a minute (deliberately, to respect Hydrawise's real
    // rate limit — see _liveRelayMap()), so right after a Stop click the
    // live data can still show the zone as running for up to that whole
    // minute even though we know for certain it just stopped. We already
    // have the accurate answer locally, for free, so use it.
    const recentLocal = await this._recentLocalOverride(zone.id);
    if (recentLocal) return recentLocal;

    const live = await this._liveRelayMap();
    if (!live) return null;

    // Prefer matching on an explicitly-configured Hydrawise Relay ID
    // (Zones page); otherwise match on the zone's plain number against
    // Hydrawise's physical `relay` field.
    const hasExplicitRelayId = !!zone.hydrawise_relay_id;
    const lookupKey = hasExplicitRelayId ? String(zone.hydrawise_relay_id) : String(zone.number);
    const relay = hasExplicitRelayId ? live.byRelayId.get(lookupKey) : live.byPhysicalNumber.get(lookupKey);
    if (!relay) return null; // no matching relay on the real controller

    const t = Number(relay.time);

    // Confirmed against this account's actual API response:
    //   time === 1        → running right now (timestr shows "Now")
    //   type === 110      → suspended (timestr is empty, time is a huge
    //                        placeholder value rather than a real countdown)
    // The large-time-value fallback below used to fire on `type !== 110`
    // rather than "type is missing", which meant ANY zone reporting a huge
    // `time` value got misread as suspended — including a zone that
    // simply has no upcoming scheduled run at all (which also reports a
    // large placeholder time) and isn't suspended in any real sense. This
    // surfaced right after disabling Hydrawise's own auto-scheduled
    // programs: every zone lost its "next run" and got wrongly flagged as
    // suspended, even though Hydrawise's own app showed them as perfectly
    // normal/available. The fallback is now scoped to ONLY apply when
    // `type` is missing entirely, so it can't override a `type` value
    // that positively says "not suspended".
    if (t === 1) {
      // Running now — prefer our own run_log for a precise end time,
      // since we know exactly what duration we told it to run for.
      const local = await this._localStatus(zone.id);
      if (local.state === 'running') return local;
      const secsLeft = Number(relay.run) || null;
      // Anchor to when this data was actually FETCHED from Hydrawise
      // (_globalLiveCache.fetchedAt), not to Date.now() at calculation
      // time. relay.run is a snapshot that stays frozen for up to
      // ttlMs (~60s) while the cache is reused across repeated status
      // checks — computing endsAt off a fresh Date.now() each time
      // against that same frozen number made the "time left" creep
      // FORWARD on every recheck instead of counting down, becoming
      // very visible once status started polling every ~12s. Anchoring
      // to fetchedAt gives a fixed target that only moves when the
      // cache actually refreshes with new real data.
      const endsAt = secsLeft ? _globalLiveCache.fetchedAt + secsLeft * 1000 : null;
      return {
        state: 'running',
        detail: secsLeft ? `~${Math.ceil(secsLeft / 60)} min (Hydrawise)` : (relay.name ? `${relay.name} running` : 'running (Hydrawise)'),
        endsAt,
        live: true,
      };
    }

    // A "suspended" flag from Hydrawise (type === 110) is no longer
    // surfaced as its own status — it turned out not to affect Run/Stop
    // in practice (confirmed directly against Hole 18), and there's no
    // reliable way to clear it through the public API anyway. Showing an
    // alarming red "Suspended" badge for something that doesn't actually
    // change how a zone behaves was just confusing for anyone running
    // the app day to day, so any zone Hydrawise reports this way now
    // just shows as Idle like normal.
    return { state: 'idle', detail: null, live: true };
  }

  /**
   * Returns our own local run_log-derived status for this zone, but
   * ONLY when the most recent recorded action is fresh enough (< 90s
   * old) to be more trustworthy than Hydrawise's live cache, which can
   * lag up to about 60s behind. Older than that, returns null so the
   * caller falls through to the normal live check — we don't want to
   * keep trusting local data forever, only in this short window right
   * after we ourselves just did something.
   */
  async _recentLocalOverride(zoneId) {
    const { rows } = await query(
      `SELECT * FROM run_log WHERE zone_id = $1 AND status = 'success'
       AND action IN ('run','runall','stop','stopall')
       ORDER BY ts DESC LIMIT 1`,
      [zoneId]
    );
    const last = rows[0];
    if (!last) return null;
    const ageMs = Date.now() - new Date(last.ts).getTime();
    if (ageMs > 90000) return null;
    return this._localStatus(zoneId);
  }

  /** Derives current zone status from our own run_log only (mock mode, or fallback when live lookup can't be trusted). */
  async _localStatus(zoneId) {
    const { rows } = await query(
      `SELECT * FROM run_log WHERE zone_id = $1 AND status = 'success'
       AND action IN ('run','runall','stop','stopall','suspend','resume')
       ORDER BY ts DESC LIMIT 1`,
      [zoneId]
    );
    const last = rows[0];
    if (!last) return { state: 'idle', detail: null };

    const tsEpoch = new Date(last.ts).getTime();

    if (last.action === 'run' || last.action === 'runall') {
      const endsAt = tsEpoch + (last.duration_minutes || 0) * 60000;
      if (Date.now() < endsAt) {
        return { state: 'running', detail: 'ends ' + fmtTime(endsAt), endsAt };
      }
      return { state: 'idle', detail: null };
    }

    if (last.action === 'suspend' && (last.message || '').startsWith('until:')) {
      const until = new Date(last.message.slice(6)).getTime();
      if (until && Date.now() < until) {
        return { state: 'suspended', detail: 'until ' + fmtDayTime(until) };
      }
      return { state: 'idle', detail: null };
    }

    return { state: 'idle', detail: null };
  }

  /** Raw, unprocessed statusschedule.php response — for troubleshooting the live-status matching logic against your actual account's real field names/values. Read-only, no zone changes. */
  async rawStatusSchedule() {
    if (!this.apiKey) return { error: 'No Hydrawise API key is configured in Settings.' };
    try {
      const params = { api_key: this.apiKey };
      if (this.controllerId) params.controller_id = this.controllerId;
      const usp = new URLSearchParams(params);
      const url = `https://api.hydrawise.com/api/v1/statusschedule.php?${usp.toString()}`;
      const raw = await fetchWithTimeout(url, 8000);
      return { raw };
    } catch (e) {
      return { error: e.message };
    }
  }

  /**
   * Lists every controller on this Hydrawise account, with each one's
   * real internal controller_id (needed to pin API calls to the correct
   * one — see the comment on _liveRelayMap() for why that matters once
   * an account has more than one controller). Use this to find the ID
   * for your real, configured controller and paste it into Settings.
   */
  async listControllers() {
    if (!this.apiKey) return { error: 'No Hydrawise API key is configured in Settings.' };
    try {
      const usp = new URLSearchParams({ api_key: this.apiKey, type: 'controllers' });
      const url = `https://api.hydrawise.com/api/v1/customerdetails.php?${usp.toString()}`;
      const raw = await fetchWithTimeout(url, 8000);
      return { raw };
    } catch (e) {
      return { error: e.message };
    }
  }

  async _mock(zoneId, programId, action, minutes, triggeredBy, message) {
    await logRun(zoneId, programId, action, minutes, triggeredBy, 'success', message);
    return { ok: true, mock: true, message };
  }

  /**
   * Checks our OWN recent request count before attempting a live call, so
   * we back off proactively instead of firing and finding out we've
   * already blown Hydrawise's real limit of 10 requests per 5 minutes.
   * The incident this exists to prevent: several Stop All clicks queued
   * 100+ commands into the same few minutes, which instantly exceeded the
   * limit — and every subsequent request (including unrelated, legitimate
   * scheduled runs) then failed too, for the better part of 20 minutes,
   * because nothing was watching our own request volume ahead of time.
   * Leaves headroom (throttles at 8, not 10) since Hydrawise's own count
   * may include activity from elsewhere (their app, another tool) that we
   * have no visibility into.
   */
  /**
   * Counts only requests that ACTUALLY reached Hydrawise in the last 5
   * minutes — this was the real bug behind tonight's throttle getting
   * permanently stuck. The count previously included every row
   * regardless of message, which meant a BLOCKED attempt (one this same
   * check had already refused to send) still counted as if it were real
   * traffic. Once 6+ blocked attempts existed in the window, each retry
   * would itself get blocked and logged, refreshing the count and
   * keeping the throttle tripped indefinitely — no amount of waiting
   * could clear it, since the retries were the only thing keeping it
   * full. Excluding rows whose own message says "internal throttle"
   * means only genuine attempts (successful or genuinely rejected by
   * Hydrawise) count toward the limit.
   */
  async _nearRateLimit() {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS c FROM run_log
       WHERE action IN ('run','stop') AND ts > now() - interval '5 minutes'
         AND COALESCE(message, '') NOT ILIKE '%internal throttle%'`
    );
    return rows[0].c >= 6;
  }

  async _real(endpoint, params, zoneId, programId, action, minutes, triggeredBy, extraMessage) {
    if (await this._nearRateLimit()) {
      const message = 'Hydrawise API error: internal throttle — approaching the 10-requests-per-5-minutes limit, holding off to let it clear.';
      await logRun(zoneId, programId, action, minutes, triggeredBy, 'error', message);
      return { ok: false, mock: false, message };
    }
    // controller_id deliberately NOT added here — per Hunter's official
    // REST API v1.4 spec, it's documented as a valid parameter only for
    // statusschedule.php and the BULK 'suspendall' action. None of the
    // single-zone actions this wrapper is used for (run, stop, suspend)
    // document it at all — relay_id alone is a unique ID across the
    // whole account, already telling Hydrawise exactly which zone (and
    // therefore which controller) to act on. Sending controller_id here
    // anyway (an earlier fix, made before this spec was found) was an
    // undocumented, extra parameter that Hydrawise appears to tolerate
    // for 'run' but outright reject as an invalid combination for
    // 'suspend' — which is almost certainly why every suspend/resume
    // attempt tonight either silently no-op'd or errored outright.
    const allParams = { ...params, api_key: this.apiKey };
    const usp = new URLSearchParams(allParams);
    const url = `https://api.hydrawise.com/api/v1/${endpoint}?${usp.toString()}`;
    let ok = false;
    let message = extraMessage || '';
    try {
      const raw = await fetchWithTimeout(url, 8000);
      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        // Hydrawise sometimes returns plain text instead of JSON —
        // notably a rate-limit message (something like "Exceeded
        // maximum..."). Surface that text directly rather than a
        // confusing "Unexpected token" JS parse error.
        message = `Hydrawise API error: ${raw.slice(0, 200)}`;
        await logRun(zoneId, programId, action, minutes, triggeredBy, 'error', message);
        return { ok: false, mock: false, message };
      }
      if (data && data.message_type !== 'error') {
        ok = true;
        message = [message, data.message || 'OK'].filter(Boolean).join(' ');
      } else {
        message = (data && data.message) || `Unexpected response: ${raw.slice(0, 200)}`;
      }
    } catch (e) {
      message = 'Error calling Hydrawise API: ' + e.message;
    }
    await logRun(zoneId, programId, action, minutes, triggeredBy, ok ? 'success' : 'error', message);
    return { ok, mock: false, message };
  }
}

function fetchWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}
function fmtDayTime(ts) {
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
}

module.exports = { HydrawiseClient, fmtTime, fmtDayTime };
