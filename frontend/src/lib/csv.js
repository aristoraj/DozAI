// Download a file and build CSV text.

export function download(filename, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
export const toCsv = (head, rows) => [head, ...rows].map(r => r.map(csvCell).join(",")).join("\n");
