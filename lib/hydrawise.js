const https = require('https');
const { query } = require('./db');
const { getSetting, logRun } = require('./settings');

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

  relayId(zone) {
    return zone.hydrawise_relay_id || String(zone.number);
  }

  async runZone(zone, minutes, triggeredBy, programId = null) {
    if (this.mock) {
      return this._mock(zone.id, programId, 'run', minutes, triggeredBy,
        `MOCK: would call setzone.php?action=run&relay_id=${this.relayId(zone)}&custom=${minutes * 60}`);
    }
    return this._real('setzone.php', { action: 'run', relay_id: this.relayId(zone), custom: minutes * 60 },
      zone.id, programId, 'run', minutes, triggeredBy);
  }

  async stopZone(zone, triggeredBy, programId = null) {
    if (this.mock) {
      return this._mock(zone.id, programId, 'stop', null, triggeredBy,
        `MOCK: would call setzone.php?action=stop&relay_id=${this.relayId(zone)}`);
    }
    return this._real('setzone.php', { action: 'stop', relay_id: this.relayId(zone) },
      zone.id, programId, 'stop', null, triggeredBy);
  }

  async suspendZone(zone, untilTs, triggeredBy) {
    const untilIso = new Date(untilTs).toISOString();
    if (this.mock) {
      return this._mock(zone.id, null, 'suspend', null, triggeredBy, `until:${untilIso}`);
    }
    return this._real('setzone.php', { action: 'suspend', relay_id: this.relayId(zone), period_id: Math.floor(untilTs / 1000) },
      zone.id, null, 'suspend', null, triggeredBy, `until:${untilIso}`);
  }

  async resumeZone(zone, triggeredBy) {
    if (this.mock) {
      return this._mock(zone.id, null, 'resume', null, triggeredBy, 'MOCK resume');
    }
    return this._real('setzone.php', { action: 'suspend', relay_id: this.relayId(zone), period_id: 0 },
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

  /** Fetches statusschedule.php once per HydrawiseClient instance (i.e. once per page load, not once per zone) and caches it. */
  async _liveRelayMap() {
    if (this._liveMapPromise) return this._liveMapPromise;
    this._liveMapPromise = (async () => {
      try {
        const params = { api_key: this.apiKey };
        if (this.controllerSerial) params.controller_id = this.controllerSerial;
        const usp = new URLSearchParams(params);
        const url = `https://api.hydrawise.com/api/v1/statusschedule.php?${usp.toString()}`;
        const raw = await fetchWithTimeout(url, 8000);
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.relays)) return null;

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

        // Zones started manually (from the Hydrawise app, or a stale
        // schedule) don't reliably show relay.time === 1 in the `relays`
        // list above — the response also carries a separate top-level
        // `running` array that's the authoritative "is this on right
        // now" source. Index it the same two ways.
        const runningByRelayId = new Map();
        const runningByPhysicalNumber = new Map();
        if (Array.isArray(data.running)) {
          for (const r of data.running) {
            runningByRelayId.set(String(r.relay_id), r);
            if (r.relay != null) runningByPhysicalNumber.set(String(r.relay), r);
          }
        }

        return { byRelayId, byPhysicalNumber, runningByRelayId, runningByPhysicalNumber };
      } catch (e) {
        console.error('Hydrawise live status fetch failed:', e.message);
        return null;
      }
    })();
    return this._liveMapPromise;
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

    const runningEntry = hasExplicitRelayId
      ? live.runningByRelayId.get(lookupKey)
      : live.runningByPhysicalNumber.get(lookupKey);

    const t = Number(relay.time);

    // Hydrawise's documented contract: relay.time === 1 means the zone
    // is running right now. There's no officially documented "suspended"
    // flag in this endpoint, but in practice a suspension pushes the
    // next-run time far into the future — well beyond any real schedule
    // gap — so a very large value is treated as suspended here. If this
    // ever mislabels a legitimately long gap between waterings as
    // "suspended", tighten or loosen this threshold.
    const SUSPENDED_THRESHOLD_SECONDS = 60 * 24 * 3600; // 60 days

    if (t === 1 || runningEntry) {
      // Running now — prefer our own run_log for a precise end time,
      // since we know exactly what duration we told it to run for.
      const local = await this._localStatus(zone.id);
      if (local.state === 'running') return local;
      const secsLeft = Number(relay.run) || (runningEntry && Number(runningEntry.time_left)) || null;
      return {
        state: 'running',
        detail: secsLeft ? `~${Math.ceil(secsLeft / 60)} min left (Hydrawise)` : (relay.name ? `${relay.name} running` : 'running (Hydrawise)'),
        live: true,
      };
    }

    if (t >= SUSPENDED_THRESHOLD_SECONDS) {
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
      const params = { api_key: this.apiKey };
      if (this.controllerSerial) params.controller_id = this.controllerSerial;
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
      const data = JSON.parse(raw);
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
