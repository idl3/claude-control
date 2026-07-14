import {
  extraDeliveryFields,
  formatPrLabel,
  outcomeBadge,
  parsePrUrl,
  safeParseDeliveryPayload,
  type DeliveryPayload,
} from '../lib/delivery';

// react-markdown `div` component override: delivery nodes are planted by
// remarkDelivery as a plain `div` tagged via data-delivery/data-payload (see
// lib/delivery.ts's deliveryNode — mirrors MarkdownImg's data-embed pattern
// in EmbeddedMedia.tsx). Every other markdown-produced <div> passes through
// untouched.
type MdDivProps = {
  node?: unknown;
  'data-delivery'?: string;
  'data-payload'?: string;
} & React.HTMLAttributes<HTMLDivElement>;

export function MarkdownDiv(props: MdDivProps) {
  const { node: _node, 'data-delivery': isDelivery, 'data-payload': payloadJson, ...rest } = props;
  if (isDelivery !== 'true' || typeof payloadJson !== 'string') {
    return <div {...rest} />;
  }
  const payload = safeParseDeliveryPayload(payloadJson);
  if (!payload) {
    // Shape guard failed after all (shouldn't happen — remarkDelivery only
    // plants this node for payloads it already validated) — fail safe to a
    // plain code block instead of a broken card.
    return <code className="delivery-fallback">{payloadJson}</code>;
  }
  return <DeliveryCard payload={payload} />;
}

function DeliveryCard({ payload }: { payload: DeliveryPayload }) {
  const badge = outcomeBadge(payload.outcome);
  const parsedPr = payload.prUrl ? parsePrUrl(payload.prUrl) : null;
  const extra = extraDeliveryFields(payload);

  return (
    <div className="delivery-card">
      <div className="delivery-card-row">
        <span className={`delivery-badge delivery-badge-${badge.tone}`}>{badge.label}</span>
        {payload.branch ? <code className="delivery-branch">{payload.branch}</code> : null}
      </div>
      {payload.prUrl ? (
        <a
          className="delivery-pr-link"
          href={payload.prUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {parsedPr ? formatPrLabel(parsedPr) : payload.prUrl}
        </a>
      ) : null}
      {extra.length > 0 ? (
        <dl className="delivery-extra">
          {extra.map(([key, value]) => (
            <div className="delivery-extra-row" key={key}>
              <dt>{key}</dt>
              <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
