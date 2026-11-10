import { CopyButton } from '../ui';
import styles from './code-sample.module.css';

export function CodeSample({ title, code }: { title: string; code: string }) {
  return (
    <figure className={styles.sample}>
      <figcaption className={styles.caption}>
        <span>{title}</span>
        <CopyButton text={code} label={`Copy ${title.toLowerCase()}`} />
      </figcaption>
      <pre className={styles.code} tabIndex={0} aria-label={title}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}
