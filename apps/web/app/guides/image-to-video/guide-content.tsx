import { Fragment, type ReactNode } from 'react';
import { CodeSample } from '../../docs/code-sample';

type GuideBlock =
  { type: 'paragraph'; text: string } | { type: 'code'; text: string; language: string };
type GuideSection = { id: string; title: string; blocks: GuideBlock[] };

// This adapter renders the headings, paragraphs and fenced examples in the canonical walkthrough.
// React escapes all text. Markdown HTML is never interpreted.
export function parseGuide(markdown: string) {
  let title = '';
  const introduction: GuideBlock[] = [];
  const sections: GuideSection[] = [];
  let blocks = introduction;
  let paragraph: string[] = [];
  let code: string[] | undefined;
  let language = '';
  const finishParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (const line of markdown.split('\n')) {
    if (code) {
      if (line === '```') {
        blocks.push({ type: 'code', text: code.join('\n'), language });
        code = undefined;
      } else code.push(line);
    } else if (line.startsWith('```')) {
      finishParagraph();
      code = [];
      language = line.slice(3).trim();
    } else if (line.startsWith('# ')) {
      finishParagraph();
      title = line.slice(2);
    } else if (line.startsWith('## ')) {
      finishParagraph();
      const heading = line.slice(3);
      const id = heading
        .replace(/^\d+\.\s*/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const section = { id, title: heading, blocks: [] };
      sections.push(section);
      blocks = section.blocks;
    } else if (!line.trim()) finishParagraph();
    else paragraph.push(line);
  }
  finishParagraph();
  if (code) throw new Error('The image-to-video walkthrough has an unclosed code fence.');
  return { title, introduction, sections };
}

function guideText(text: string, origin: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const url = new URL(link[2]!, origin);
      if (url.origin === new URL(origin).origin && ['http:', 'https:'].includes(url.protocol))
        return (
          <a key={index} href={`${url.pathname}${url.search}${url.hash}`}>
            {link[1]}
          </a>
        );
      return <Fragment key={index}>{link[1]}</Fragment>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function GuideBlocks({
  blocks,
  origin,
  codeTitle,
}: {
  blocks: GuideBlock[];
  origin: string;
  codeTitle?: string;
}) {
  return blocks.map((block, index) =>
    block.type === 'code' ? (
      <CodeSample
        key={index}
        title={codeTitle ?? (block.language === 'json' ? 'JSON example' : 'CLI commands')}
        code={block.text}
      />
    ) : (
      <p key={index}>{guideText(block.text, origin)}</p>
    ),
  );
}
