// The placeholder wasp: a simple mark shown wherever a wasp has no portrait of its own (the built-in three included).
// The name BEE_MARK_URL is kept from the upstream code so imports stay stable.

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
<rect width="120" height="120" rx="18" fill="#14130f"/>
<g fill="none" stroke="#e8b10c" stroke-width="3" stroke-linecap="round">
<path d="M55 30c-5-9-12-12-19-10"/><path d="M65 30c5-9 12-12 19-10"/>
</g>
<path d="M57 46 26 34c-6-2-9 5-4 8l33 12z" fill="#a9b4c8" fill-opacity=".35" stroke="#a9b4c8" stroke-width="2"/>
<path d="M63 46l31-12c6-2 9 5 4 8L65 54z" fill="#a9b4c8" fill-opacity=".35" stroke="#a9b4c8" stroke-width="2"/>
<ellipse cx="60" cy="49" rx="9" ry="8" fill="#e8b10c"/>
<path d="M51 60c0-4 4-6 9-6s9 2 9 6l-3 34c-1 6-3 10-6 14-3-4-5-8-6-14z" fill="#e8b10c"/>
<g fill="#14130f"><path d="M51.5 66h17l-.5 6h-16z"/><path d="M52.6 79h14.8l-.6 6H53.2z"/><path d="M54 92h12l-.9 5h-10.2z"/></g>
<circle cx="60" cy="33" r="10" fill="#e8b10c"/>
<path d="M53 31l5 3M67 31l-5 3" stroke="#14130f" stroke-width="2.6" stroke-linecap="round"/>
</svg>`;

/** Usable anywhere an image URL is (the page's CSP allows data: images). */
export const BEE_MARK_URL = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
