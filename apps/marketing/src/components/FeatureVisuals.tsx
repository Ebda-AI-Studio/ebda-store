import type { HeroFeatures } from '../lib/content';
import type { Locale } from '../lib/site';

function Glyph({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * The two hands-on hero features, each with a visual drawn as real UI (never an illustration): the page
 * editor beside a crop of a real look, a WhatsApp order message with the push it triggers. The UI is illustrative and not
 * interactive, so each visual is one labelled image to assistive tech. Server-rendered, no JS.
 */
export function FeatureVisuals({ copy, locale }: { copy: HeroFeatures; locale: Locale }) {
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const { editor, orders } = copy;
  return (
    <ul className="fx">
      <li className="fx-card" data-feature="editor">
        <div className="fx-visual fx-editor" role="img" aria-label={editor.previewAlt}>
          <div className="fx-ui" dir={dir}>
            <p className="fx-label">{editor.sectionsLabel}</p>
            <ul className="fx-rows">
              {editor.sections.map(x => (
                <li key={x}>
                  <span className="fx-grip" />
                  {x}
                </li>
              ))}
            </ul>
            <p className="fx-label">{editor.colourLabel}</p>
            <div className="fx-dots">
              <span style={{ background: '#141414' }} />
              <span style={{ background: '#c89b3c' }} />
              <span style={{ background: '#1f4e54' }} />
              <span style={{ background: '#6e1f2a' }} />
            </div>
          </div>
          <div className="fx-preview">
            <img
              src="/looks/phone-600.webp"
              width={600}
              height={1298}
              alt=""
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
        <div className="fx-copy">
          <h3>{editor.t}</h3>
          <p>{editor.d}</p>
        </div>
      </li>

      <li className="fx-card" data-feature="orders">
        <div className="fx-visual fx-orders" role="img" aria-label={orders.chatLabel}>
          <div className="fx-ui fx-chat" dir={dir}>
            {orders.message.map(line => (
              <p key={line}>{line}</p>
            ))}
            <span className="fx-send">
              <Glyph d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5Z" />
              {orders.send}
            </span>
          </div>
          <div className="fx-ui fx-push" dir={dir}>
            <span className="fx-push-mark" />
            <span>
              <strong>{orders.pushT}</strong>
              <span>{orders.pushD}</span>
            </span>
          </div>
        </div>
        <div className="fx-copy">
          <h3>{orders.t}</h3>
          <p>{orders.d}</p>
        </div>
      </li>
    </ul>
  );
}
