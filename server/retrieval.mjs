// Unicode words and CJK bigrams keep Chinese retrieval useful without a tokenizer service.
export function terms(text, max = 100) {
  const lowered = text.toLowerCase();
  const result = lowered.match(/[a-z0-9_/-]{2,}/g) || [];
  for (const run of lowered.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) result.push(run);
    for (let i = 0; i < run.length - 1; i++) result.push(run.slice(i, i + 2));
  }
  return [...new Set(result)].slice(0, max);
}
export function retrieve(resources, query, limit = 5, store, mode = 'ranked') {
  resources = resources.filter(r => !r.expiresAt || Date.parse(r.expiresAt) > Date.now());
  const tokens = terms(query);
  if (!tokens.length) return [];
  const chunks = [];
  let indexed;
  if (store && resources.length) {
    const match = tokens.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    const ids = resources.map(r => r.id);
    indexed = store.all(`SELECT s.resource_id,s.offset,c.content FROM knowledge_search s JOIN knowledge_chunks c ON c.resource_id=s.resource_id AND c.offset=s.offset WHERE knowledge_search MATCH ? AND s.resource_id IN (${ids.map(() => '?').join(',')}) ORDER BY rank LIMIT 200`, match, ...ids);
  }
  for (const resource of resources) {
    const body = resource.body || resource.description;
    const candidates = indexed ? indexed.filter(c => c.resource_id === resource.id).map(c => ({ offset: Number(c.offset), content: c.content })) : Array.from({ length: Math.ceil(body.length / 750) }, (_, i) => ({ offset: i * 750, content: body.slice(i * 750, i * 750 + 1000) }));
    for (const { offset: start, content } of candidates) {
      const metadata = `${resource.name} ${resource.domain} ${resource.description}`.toLowerCase();
      const lower = content.toLowerCase();
      const score = tokens.reduce((sum, term) => sum + (metadata.includes(term) ? 3 : 0) + (lower.includes(term) ? 1 : 0), 0);
      if (score > 0) chunks.push({ resourceId: resource.id, title: resource.name, content, score, offset: start, revision: resource.revision || 1, documentVersion: resource.documentVersion || '', updated: resource.updated, sourceUrl: resource.sourceUrl || '' });
    }
  }
  const ranked = chunks.sort((a, b) => b.score - a.score);
  if (mode !== 'diverse') return ranked.slice(0, limit);
  const selected = [];
  // First give each matching document one slot; then add non-overlapping context.
  for (const perDocument of [1, 2]) for (const chunk of ranked) {
    if (selected.length >= limit) return selected;
    const same = selected.filter(s => s.resourceId === chunk.resourceId);
    if (same.length >= perDocument || same.some(s => chunk.offset < s.offset + s.content.length && s.offset < chunk.offset + chunk.content.length)) continue;
    selected.push(chunk);
  }
  return selected;
}
