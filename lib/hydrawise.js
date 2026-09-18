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
    return new HydrawiseClient(mock, apiKey, controllerSerial);
  }

  constructor(mock, apiKey, controllerSerial) {
    this.mock = mock;
    this.apiKey = apiKey;
    this.controllerSerial = controllerSerial;
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
    return this._real('setzone.php', { action: 'run', relay_id: relayId, custom: minutes * 60 },
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

  async suspendZone(zone, untilTs, triggeredBy) {
    const relayId = await this.relayId(zone);
    const untilIso = new Date(untilTs).toISOString();
    if (this.mock) {
      return this._mock(zone.id, null, 'suspend', null, triggeredBy, `until:${untilIso}`);
    }
    return this._real('setzone.php', { action: 'suspend', relay_id: relayId, period_id: Math.floor(untilTs / 1000) },
      zone.id, null, 'suspend', null, triggeredBy, `until:${untilIso}`);
  }

  async resumeZone(zone, triggeredBy) {
    const relayId = await this.relayId(zone);
    if (this.mock) {
      return this._mock(zone.id, null, 'resume', null, triggeredBy, 'MOCK resume');
    }
    return this._real('setzone.php', { action: 'suspend', relay_id: relayId, period_id: 0 },
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
      try {        // NOTE: deliberately NOT sending controller_id here. The
        // "Controller serial number" field in Settings holds the serial
        // printed on the physical PHC-2400 unit — that is NOT the same
        // as Hydrawise's cloud controller_id (an internal number their
        // servers assign), and sending the serial as controller_id makes
        // the whole request fail with "Controller not found". This
        // account only has one controller, and Hydrawise's API defaults
        // to it automatically when controller_id is omitted.
        const params = { api_key: this.apiKey };
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
    // The large-time-value check is kept only as a fallback in case a
    // future response omits `type` for some reason.
    const SUSPENDED_TYPE = 110;
    const SUSPENDED_THRESHOLD_SECONDS = 60 * 24 * 3600; // 60 days, fallback only

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

    if (Number(relay.type) === SUSPENDED_TYPE || t >= SUSPENDED_THRESHOLD_SECONDS) {
      return { state: 'suspended', detail: relay.timestr ? `Hydrawise: ${relay.timestr}` : 'suspended on Hydrawise', live: true };
    }

    return { state: 'idle', detail: null, live: true };
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
      // See the comment in _liveRelayMap() — controller_id deliberately omitted.
      const params = { api_key: this.apiKey };
      const usp = new URLSearchParams(params);
      const url = `https://api.hydrawise.com/api/v1/statusschedule.php?${usp.toString()}`;
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

  async _real(endpoint, params, zoneId, programId, action, minutes, triggeredBy, extraMessage) {
    const usp = new URLSearchParams({ ...params, api_key: this.apiKey });
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
