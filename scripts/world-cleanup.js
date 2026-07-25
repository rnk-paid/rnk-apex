/**
 * Real world document cleanup
 */
export class ApexWorldCleanup {
  constructor(log = () => {}) {
    this.log = log;
  }

  async dryRun(options = {}) {
    const report = {
      chat: { wouldDelete: 0, olderThan: null },
      combats: { wouldDelete: 0 },
      compendiums: { packs: 0 },
      notes: []
    };

    if (options.doCleanupChat !== false) {
      const days = Number(options.chatRetentionDays) || 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      report.chat.olderThan = new Date(cutoff).toISOString();
      try {
        report.chat.wouldDelete = (game.messages?.contents ?? []).reduce((acc, m) => {
          const ts = m?.timestamp ?? 0;
          return acc + (ts > 0 && ts < cutoff ? 1 : 0);
        }, 0);
      } catch {
        report.notes.push('Could not count chat messages');
      }
    }

    if (options.doCleanupInactiveCombats !== false) {
      try {
        report.combats.wouldDelete = (game.combats?.contents ?? []).reduce((acc, c) => {
          const active = !!c?.started;
          const turns = Array.isArray(c?.turns) ? c.turns.length > 0 : false;
          return acc + (!active && !turns ? 1 : 0);
        }, 0);
      } catch {
        report.notes.push('Could not count combats');
      }
    }

    if (options.doRebuildCompendiumIndexes !== false) {
      try {
        report.compendiums.packs = Array.from(game.packs?.values?.() ?? []).length;
      } catch {
        report.notes.push('Could not count packs');
      }
    }

    return report;
  }

  async run(options = {}) {
    if (!game.user?.isGM) throw new Error('Apex cleanup requires GM');

    const report = {
      chat: { deleted: 0 },
      combats: { deleted: 0 },
      compendiums: { packs: 0, docs: 0 },
      notes: []
    };

    if (options.doCleanupChat !== false) {
      const days = Number(options.chatRetentionDays) || 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const ids = (game.messages?.contents ?? [])
        .filter((m) => (m?.timestamp ?? 0) > 0 && m.timestamp < cutoff)
        .map((m) => m.id)
        .filter(Boolean);
      if (ids.length) {
        this.log(`Deleting ${ids.length} chat messages older than ${days}d`);
        for (let i = 0; i < ids.length; i += 100) {
          await ChatMessage.deleteDocuments(ids.slice(i, i + 100));
        }
        report.chat.deleted = ids.length;
      } else {
        this.log('No old chat to delete');
      }
    }

    if (options.doCleanupInactiveCombats !== false) {
      const ids = (game.combats?.contents ?? [])
        .filter((c) => !c?.started && !(Array.isArray(c?.turns) && c.turns.length > 0))
        .map((c) => c.id)
        .filter(Boolean);
      if (ids.length) {
        this.log(`Deleting ${ids.length} inactive combats`);
        for (let i = 0; i < ids.length; i += 50) {
          await Combat.deleteDocuments(ids.slice(i, i + 50));
        }
        report.combats.deleted = ids.length;
      } else {
        this.log('No inactive combats to delete');
      }
    }

    if (options.doRebuildCompendiumIndexes !== false) {
      const packs = Array.from(game.packs?.values?.() ?? []);
      let docs = 0;
      for (const pack of packs) {
        try {
          const index = await pack.getIndex();
          docs += Array.isArray(index) ? index.length : (index?.size ?? 0);
        } catch (e) {
          report.notes.push(`index fail ${pack.collection}: ${e.message}`);
        }
      }
      report.compendiums.packs = packs.length;
      report.compendiums.docs = docs;
      this.log(`Warmed ${packs.length} compendium packs (~${docs} docs)`);
    }

    return report;
  }
}
