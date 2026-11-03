/**
 * The static first paint of the studio home's living geometry (Ruling MKT-STUDIO-C-1): the same girih lattices that
 * `public/studio-pattern.js` animates on a canvas after the page has loaded, drawn once as SVG patterns. It is also the
 * whole artwork under `prefers-reduced-motion`, `save-data` and no-JS. Keep the constants in step with that file.
 *   8-fold family (Ebda Store): 8-point stars on every even lattice point, turned squares on the odd ones; the star
 *   tips (long on the diagonals) meet the squares and each other, so the lines close.
 *   6-fold family (Ebda Chat): a 6-point star on every point of a triangular lattice, tips touching.
 * Colours come from CSS classes (.g-gold / .g-brass / .g-silver) so the page owns the palette.
 */
const f = (n: number) => String(Math.round(n * 10) / 10);

const star8 = (s: number) => {
  const pts: string[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const r = k % 2 ? 0.29 * s : k % 4 === 0 ? 0.62 * s : 0.707 * s;
    pts.push(`${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}`);
  }
  return `M${pts.join('L')}Z`;
};
const inner8 = (s: number) => {
  const pts: string[] = [];
  for (let k = 0; k < 16; k++) {
    const a = (k * Math.PI) / 8;
    const r = (k % 2 ? 0.14 : 0.3) * s;
    pts.push(`${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}`);
  }
  return `M${pts.join('L')}Z`;
};
const diamond = (s: number) => {
  const d = 0.38 * s;
  return `M${f(d)} 0L0 ${f(d)}L${f(-d)} 0L0 ${f(-d)}Z`;
};
const star6 = (s: number) => {
  const pts: string[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6;
    const r = k % 2 ? 0.2887 * s : 0.5 * s;
    pts.push(`${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}`);
  }
  return `M${pts.join('L')}Z`;
};
const inner6 = (s: number) => {
  const pts: string[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k * Math.PI) / 6;
    const r = (k % 2 ? 0.1 : 0.2) * s;
    pts.push(`${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}`);
  }
  return `M${pts.join('L')}Z`;
};

function P8({ id, s }: { id: string; s: number }) {
  const T = 2 * s;
  const uses: { x: number; y: number; k: 'st' | 'di' }[] = [];
  for (let i = -1; i <= 2; i++)
    for (let j = -1; j <= 2; j++) {
      const x = (i + 0.5) * s;
      const y = (j + 0.5) * s;
      const reach = 0.71 * s;
      if (x + reach < 0 || x - reach > T || y + reach < 0 || y - reach > T) continue;
      uses.push({ x, y, k: (i + j) % 2 === 0 ? 'st' : 'di' });
    }
  return (
    <pattern id={id} width={T} height={T} patternUnits="userSpaceOnUse">
      <path id={`${id}-st`} d={star8(s)} className="g-gold" />
      <path id={`${id}-in`} d={inner8(s)} className="g-silver" />
      <path id={`${id}-di`} d={diamond(s)} className="g-brass" />
      {uses.map(u =>
        u.k === 'st' ? (
          <g key={`${u.x}-${u.y}`} transform={`translate(${f(u.x)} ${f(u.y)})`}>
            <use href={`#${id}-st`} />
            <use href={`#${id}-in`} />
          </g>
        ) : (
          <use key={`${u.x}-${u.y}`} href={`#${id}-di`} x={f(u.x)} y={f(u.y)} />
        )
      )}
    </pattern>
  );
}

function P6({ id, s }: { id: string; s: number }) {
  const H = Math.sqrt(3) * s;
  const pts: [number, number][] = [
    [0, 0],
    [s, 0],
    [0, H],
    [s, H],
    [s / 2, H / 2],
    [s / 2, -H / 2],
    [s / 2, (3 * H) / 2],
  ];
  return (
    <pattern id={id} width={s} height={H} patternUnits="userSpaceOnUse">
      <path id={`${id}-st`} d={star6(s)} className="g-gold" />
      <path id={`${id}-in`} d={inner6(s)} className="g-silver" />
      {pts.map(([x, y]) => (
        <g key={`${x}-${y}`} transform={`translate(${f(x)} ${f(y)})`}>
          <use href={`#${id}-st`} />
          <use href={`#${id}-in`} />
        </g>
      ))}
    </pattern>
  );
}

/** Field (8-fold at 64px) plus the two window lattices (8-fold and 6-fold at 40px). Pattern ids: g8, g8w, g6w. */
export function GirihPoster() {
  return (
    <svg
      className="sh-poster"
      width="100%"
      height="100%"
      preserveAspectRatio="xMinYMin slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <P8 id="g8" s={64} />
        <P8 id="g8w" s={40} />
        <P6 id="g6w" s={40} />
      </defs>
      <rect width="100%" height="100%" fill="url(#g8)" />
    </svg>
  );
}

/** A window's own lattice, shown until the canvas takes over. */
export function WindowGirih({ id }: { id: 'g8w' | 'g6w' }) {
  return (
    <svg className="sh-win-art" width="100%" height="100%" aria-hidden="true" focusable="false">
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
