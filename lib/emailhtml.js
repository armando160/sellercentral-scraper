// Small helpers for the HTML part of the emails. Gmail shows plain-text emails
// in a proportional font and wraps long lines, so space-aligned tables fall
// apart there. Every email with a table should also send HTML built from these.
export const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const LEFT = ['What', 'Data', 'Source', 'Note'];
const TD = 'padding:4px 8px;border-bottom:1px solid #e3e8ee;text-align:right;vertical-align:top';
const RED = ['FAILED', 'SIGNED OUT'];

export const htmlTable = (head, rows, boldLast = false) => `<table style="border-collapse:collapse;font:13px Arial,sans-serif;margin:6px 0 14px">
<tr>${head.map((h, i) => `<th style="background:#1F3A5F;color:#fff;padding:5px 8px;text-align:${i && !LEFT.includes(h) ? 'right' : 'left'}">${esc(h)}</th>`).join('')}</tr>
${rows.map((r, k) => `<tr style="${boldLast && k === rows.length - 1 ? 'font-weight:bold;background:#DCE6F1' : k % 2 ? 'background:#f6f8fa' : ''}">${r.map((c, i) => `<td style="${TD};${i === 0 || LEFT.includes(head[i]) ? 'text-align:left' : ''}${RED.includes(String(c)) ? ';color:#c00;font-weight:bold' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('\n')}
</table>`;

export const H = (t) => `<h3 style="font:bold 15px Arial,sans-serif;color:#1F3A5F;margin:18px 0 4px">${esc(t)}</h3>`;
export const P = (t) => `<p style="font:13px Arial,sans-serif;margin:4px 0">${esc(t)}</p>`;
export const UL = (items) => `<ul style="font:13px Arial,sans-serif;margin:4px 0;padding-left:20px">${items.map((t) => `<li style="margin:3px 0">${t}</li>`).join('')}</ul>`;
export const wrap = (inner) => `<div style="font:13px Arial,sans-serif;color:#222;max-width:760px">${inner}</div>`;
