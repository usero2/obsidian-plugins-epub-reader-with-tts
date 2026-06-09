# Build script: bundle jszip + epub.js + plugin.js into main.js
$jszip = Get-Content jszip.min.js -Raw
$epub = Get-Content epub.min.js -Raw
$plugin = Get-Content plugin.js -Raw

# JSZip: run in its own scope but expose to window.JSZip
# epub.js expects require("JSZip") — we shim that.
$content = @"
// === JSZip ===
(function(){
  var module = { exports: {} };
  var exports = module.exports;
  var define = undefined;
  $jszip
  if (typeof window !== 'undefined') { window.JSZip = module.exports; }
})();

// === epub.js ===
// epub.js UMD expects require("xmldom") and require("JSZip").
// We provide a shim require that returns window globals.
(function(){
  var origModule = typeof module !== 'undefined' ? module : undefined;
  var origExports = typeof exports !== 'undefined' ? exports : undefined;
  var module = { exports: {} };
  var exports = module.exports;
  var define = undefined;

  // Shim xmldom (epub.js uses it but only for Node; in browser DOMParser exists)
  var xmldom = { DOMParser: (typeof window !== 'undefined' && window.DOMParser) ? window.DOMParser : undefined };
  
  // Override require for this scope
  var origRequire = typeof require !== 'undefined' ? require : function(){};
  var require = function(name) {
    if (name === 'JSZip' || name === 'jszip') return window.JSZip;
    if (name === 'xmldom') return xmldom;
    return origRequire(name);
  };

  $epub

  if (typeof window !== 'undefined') {
    window.ePub = module.exports;
    if (!window.ePub && typeof module.exports === 'object' && module.exports.default) {
      window.ePub = module.exports.default;
    }
  }

  // Restore
  if (typeof origModule !== 'undefined') { module = origModule; }
  if (typeof origExports !== 'undefined') { exports = origExports; }
})();

// === Plugin ===
$plugin
"@

Set-Content -Path main.js -Value $content -Encoding UTF8
Write-Host "Build complete. main.js created."
