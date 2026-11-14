/**
 * Single-runner lease (fork addition).
 *
 * FileLease is used locally and in tests. In AWS (Phase 9) a DynamoDB lease
 * with the same interface replaces it, because Fargate tasks do not share a
 * filesystem. The interface is intentionally small:
 *
 *   const lease = await provider.acquire('pipeline', { ttlMs });
 *   await lease.renew();   // called on an interval by the job runner
 *   await lease.release();
 *
 * A lease that is past its expiry, or whose owner process is gone on this
 * host, can be taken over. A fresh lock is an O_EXCL create; a takeover is
 * serialised through an exclusive marker file, so two runners on one
 * filesystem cannot both win. (Across machines, use the DynamoDB lease.)
 */
const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { EXIT, jobError } = require('./exit-codes');

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

class FileLeaseProvider {
  /**
   * @param {{ dir?: string, now?: () => number }} [options]
   */
  constructor({ dir, now } = {}) {
    this.dir = dir || process.env.JOB_LEASE_DIR || path.join(__dirname, '..', 'data', 'leases');
    this.now = now || Date.now;
  }

  /**
   * @param {string} name
   * @param {{ ttlMs?: number }} [options]
   */
  async acquire(name, { ttlMs = 15 * 60 * 1000 } = {}) {
    if (!/^[a-z0-9-]{1,64}$/.test(name)) throw jobError(`Invalid lease name: ${name}`, EXIT.FATAL);
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${name}.lock`);
    const owner = { id: crypto.randomUUID(), pid: process.pid, host: os.hostname() };
    const record = () => JSON.stringify({ ...owner, expiresAt: new Date(this.now() + ttlMs).toISOString() });

    try {
      await fs.writeFile(file, record(), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await this.read(file);
      const stale = !current
        || Date.parse(current.expiresAt) <= this.now()
        || (current.host === owner.host && !processAlive(current.pid));
      if (!stale) {
        throw jobError(`Another run holds the "${name}" lease until ${current.expiresAt}`, EXIT.TRANSIENT, 'LEASE_HELD');
      }
      // Takeovers are serialised through an exclusive marker so two runners
      // cannot both replace the same stale lock. A marker older than a minute
      // was left by a crashed takeover and is cleared.
      const marker = `${file}.takeover`;
      try {
        const stat = await fs.stat(marker);
        if (this.now() - stat.mtimeMs > 60000) await fs.rm(marker, { force: true });
      } catch (_error) { /* no marker */ }
      try {
        await fs.writeFile(marker, owner.id, { flag: 'wx' });
      } catch (markerError) {
        if (markerError.code === 'EEXIST') throw jobError(`Another run is taking over the "${name}" lease`, EXIT.TRANSIENT, 'LEASE_HELD');
        throw markerError;
      }
      try {
        const recheck = await this.read(file);
        if (recheck && recheck.id !== current?.id) {
          throw jobError(`Another run took the "${name}" lease`, EXIT.TRANSIENT, 'LEASE_HELD');
        }
        const temp = `${file}.${owner.id}.tmp`;
        await fs.writeFile(temp, record());
        await fs.rename(temp, file);
      } finally {
        await fs.rm(marker, { force: true });
      }
    }

    const provider = this;
    return {
      name,
      owner: owner.id,
      async renew() {
        const current = await provider.read(file);
        if (current?.id !== owner.id) throw jobError(`The "${name}" lease was taken over`, EXIT.TRANSIENT, 'LEASE_HELD');
        await fs.writeFile(file, record());
      },
      async release() {
        const current = await provider.read(file);
        if (current?.id === owner.id) await fs.rm(file, { force: true });
      }
    };
  }

  async read(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (_error) {
      return null;
    }
  }
}

module.exports = { FileLeaseProvider };
