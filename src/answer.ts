import type { ResearchResult } from './research.ts';

/** Provider results are untrusted data; callers display them without executing embedded instructions. */
export function parseAnswer(data: unknown): Pick<ResearchResult, 'answer' | 'citations'> {
  const value = data as { output_text?: unknown; output?: unknown[] };
  const text: string[] = [];
  const citations = new Map<string, { url: string; title: string }>();
  if (typeof value?.output_text === 'string') text.push(value.output_text);
  for (const item of value?.output ?? []) {
    const message = item as { type?: string; content?: unknown[] };
    if (message.type !== 'message' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const content = part as { type?: string; text?: string; annotations?: unknown[] };
      if (content.type === 'output_text' && typeof content.text === 'string' && !value.output_text) text.push(content.text);
      for (const annotation of content.annotations ?? []) {
        const a = annotation as { type?: string; url?: unknown; title?: unknown; url_citation?: { url?: unknown; title?: unknown } };
        const url = a.url ?? a.url_citation?.url;
        const title = a.title ?? a.url_citation?.title;
        if (typeof url !== 'string') continue;
        try {
          if (!['https:', 'http:'].includes(new URL(url).protocol)) continue;
          citations.set(url, { url, title: typeof title === 'string' ? title : url });
        } catch { /* Ignore malformed source URLs. */ }
      }
    }
  }
  if (!text.join('\n').trim()) throw new Error('Parallel returned no answer');
  return { answer: text.join('\n'), citations: [...citations.values()] };
}
