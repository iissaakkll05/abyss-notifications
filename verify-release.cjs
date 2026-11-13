const fs=require('node:fs'),assert=require('node:assert/strict'),vm=require('node:vm');
const manifest=JSON.parse(fs.readFileSync('manifest.json','utf8'));
assert.equal(manifest.id,'abyss-notifications');assert.match(manifest.version,/^\d+\.\d+\.\d+$/);assert.equal(manifest.isDesktopOnly,false);
for(const name of ['main.js','manifest.json','styles.css'])assert.ok(fs.statSync(name).size>0,name+' is missing');
new vm.Script(fs.readFileSync('main.js','utf8'));
const names=fs.readdirSync('.');assert.ok(!names.some(n=>/^data.*\.json$|\.log$|^journal-/.test(n)),'Private runtime files must not be published');
assert.ok(fs.readFileSync('main.source.js','utf8').includes('Abyss Notifications · '+manifest.version),'Settings version differs from manifest');
console.log('Release '+manifest.version+' verified: three runtime assets, mobile bundle, no runtime state');
