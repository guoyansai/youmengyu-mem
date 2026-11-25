const body = JSON.stringify({
  filters: [{
    criteria: [
      { filterType: 10, value: "游梦鱼" },
      { filterType: 3, value: "Visual Studio Code" }
    ],
    pageNumber: 1, pageSize: 20, sortBy: 0, sortOrder: 0
  }],
  flags: 914
});
const res = await fetch("https://marketplace.visualstudio.com/_apis/gallery/extensionquery", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json;api-version=3.0-preview.1",
    "X-Market-Client-Id": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  },
  body
});
const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { console.log("non-JSON:", text.slice(0, 200)); process.exit(0); }
const exts = data.results[0].extensions;
console.log("total found:", exts.length);
for (const e of exts) {
  console.log(`- ${e.publisher.publisherName}.${e.extensionName} | displayName: "${e.displayName}" | latest: ${e.versions[0].version}`);
}
