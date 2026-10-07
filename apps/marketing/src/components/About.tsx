import { Reveal } from './Motion';

/**
 * «حكاية ابدأ»: why the name and the mark. The open-door mark is drawn inline so it can
 * animate: on reveal the light inside the arch comes up and the person (the one with the
 * idea) steps through the doorway. Without JS or with reduced motion it is the plain mark.
 */
export function About({
  title,
  paras,
  close,
  markLabel,
}: {
  title: string;
  paras: string[];
  close: string;
  markLabel: string;
}) {
  return (
    <section id="about" className="section about" aria-labelledby="about-h">
      <div className="wrap about-grid">
        <Reveal className="door-wrap">
          <svg className="door" viewBox="0 0 116 128" role="img" aria-label={markLabel}>
            <defs>
              <radialGradient id="door-light" cx="50%" cy="72%" r="55%">
                <stop offset="0" stopColor="#f5dfb0" stopOpacity="0.85" />
                <stop offset="1" stopColor="#f5dfb0" stopOpacity="0" />
              </radialGradient>
            </defs>
            <path
              className="door-glow"
              d="M30 112 V56 a28 28 0 0 1 56 0 V112 Z"
              fill="url(#door-light)"
            />
            <path
              className="door-arch"
              d="M30 112 V56 a28 28 0 0 1 56 0 V112"
              fill="none"
              stroke="#B08D57"
              strokeWidth="13"
              strokeLinecap="round"
            />
            <g className="door-person">
              <circle cx="58" cy="74" r="9" fill="#CBA873" />
              <path d="M46 104 L58 86 L70 104 Z" fill="#CBA873" />
            </g>
          </svg>
        </Reveal>
        <div className="about-copy">
          <h2 id="about-h">{title}</h2>
          {paras.map(p => (
            <p key={p}>{p}</p>
          ))}
          <p className="about-close" lang="ar">
            {close}
          </p>
        </div>
      </div>
    </section>
  );
}
