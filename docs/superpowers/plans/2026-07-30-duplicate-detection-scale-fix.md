# Duplicate Detection Scale Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make similar-image detection scale to the 150k library (currently ~4.8 hours → target seconds-to-low-minutes) and never lose already-computed groups on an interrupted run.

**Root cause (confirmed):** `_detectGroups` used a BK-tree whose pruning is ineffective at threshold 10 on 149k 64-bit hashes (degrades to ~O(n²)), and `hammingDistance` used BigInt (10–50× slower than integer math). Measured 17,266 s on the mini's 149k set. Worse, `_detectGroups` calls `clearDuplicateGroups()` up front and writes only once at the very end, so an unfinished run leaves the table empty — losing even the instant exact-duplicate matches.

**Fix:** (1) integer-math Hamming; (2) replace the BK-tree with **banding / multi-index hashing** (split each hash into `threshold+1` nibble-segments — by the pigeonhole principle any pair within the threshold shares an identical segment, so candidates come from shared buckets; verify with fast Hamming; union-find with a same-component short-circuit); (3) atomic persist (delete+insert in one transaction at the end — never wipe existing groups until the new set is ready).

**Tech Stack:** Node.js, better-sqlite3 (sync), vanilla JS. No new dependencies.

## Global Constraints

- No test framework; every task is verified by a runnable `node -e` check with expected output shown — run it and confirm before marking done.
- Preserve behavior/results: the new banding grouping must be **exact** (no missed pairs vs. the old threshold semantics) for the same threshold. The pigeonhole guarantee requires exactly `threshold+1` segments.
- Small atomic commits; Conventional Commits; end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Run node from `/Users/rhans/picture-frame`; do not `cd`; `git add` only the files each task names.
- `hammingDistance` keeps its exact signature `(hexA, hexB) => number` on 16-hex-char inputs; all callers are unchanged.

## File Structure

- Modify `src/lib/perceptualHash.js` — integer-math `hammingDistance`.
- Create `src/lib/similarGroups.js` — banding `groupSimilar(items, threshold)`.
- Modify `src/database/db.js` — add `replaceDuplicateGroups(rows)`.
- Modify `src/services/duplicateDetection.js` — use `groupSimilar` + atomic persist; drop BK-tree.
- Delete `src/lib/bkTree.js` — no longer used.
- Modify `config.json` — `similarThreshold` 10 → 8.

---

## Task 1: Integer-math Hamming distance

**Files:** Modify `src/lib/perceptualHash.js` (`hammingDistance`, lines 35-46)

- [ ] **Step 1: Replace the BigInt implementation**

Replace (perceptualHash.js:35-46):
```javascript
/**
 * Hamming distance (number of differing bits) between two 16-hex-char hashes.
 */
function hammingDistance(hexA, hexB) {
    let x = (BigInt('0x' + hexA) ^ BigInt('0x' + hexB));
    let count = 0;
    while (x > 0n) {
        count += Number(x & 1n);
        x >>= 1n;
    }
    return count;
}
```
with:
```javascript
/** Population count of a 32-bit integer (SWAR). */
function popcount32(n) {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Hamming distance (number of differing bits) between two 16-hex-char hashes.
 * Uses integer math on two 32-bit halves — ~20-50x faster than BigInt at scale.
 */
function hammingDistance(hexA, hexB) {
    const aHi = parseInt(hexA.slice(0, 8), 16), aLo = parseInt(hexA.slice(8, 16), 16);
    const bHi = parseInt(hexB.slice(0, 8), 16), bLo = parseInt(hexB.slice(8, 16), 16);
    return popcount32((aHi ^ bHi) >>> 0) + popcount32((aLo ^ bLo) >>> 0);
}
```

- [ ] **Step 2: Verify identical results to the old version + speed**

Run (checks known distances and cross-checks 10k random pairs against a BigInt reference):
```bash
node -e "
const { hammingDistance } = require('./src/lib/perceptualHash.js');
function ref(a,b){let x=BigInt('0x'+a)^BigInt('0x'+b),c=0;while(x>0n){c+=Number(x&1n);x>>=1n;}return c;}
console.log('0..0:', hammingDistance('0000000000000000','0000000000000000'), '(exp 0)');
console.log('0..f:', hammingDistance('0000000000000000','000000000000000f'), '(exp 4)');
console.log('all:', hammingDistance('0000000000000000','ffffffffffffffff'), '(exp 64)');
console.log('hiHalf:', hammingDistance('0000000000000000','ffffffff00000000'), '(exp 32)');
let ok=true;
const rnd=()=>Array.from({length:16},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
for(let i=0;i<10000;i++){const a=rnd(),b=rnd();if(hammingDistance(a,b)!==ref(a,b)){ok=false;console.log('MISMATCH',a,b);break;}}
console.log('10k random vs BigInt ref:', ok?'PASS':'FAIL');
"
```
Expected: `0..0: 0 (exp 0)`, `0..f: 4 (exp 4)`, `all: 64 (exp 64)`, `hiHalf: 32 (exp 32)`, `10k random vs BigInt ref: PASS`.

- [ ] **Step 3: Commit**
```bash
git add src/lib/perceptualHash.js
git commit -m "$(printf 'perf: integer-math hamming distance (drop BigInt)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Banding similar-grouping module

**Files:** Create `src/lib/similarGroups.js`

**Interfaces:**
- Produces: `groupSimilar(items, threshold) => Array<Array<id>>` where `items = [{id, hash}]` (hash = 16 hex chars); returns connected components of size ≥ 2 (each an array of ids) whose members are within `threshold` Hamming bits (transitively).

- [ ] **Step 1: Write the module**

Create `src/lib/similarGroups.js`:
```javascript
/**
 * Scalable near-duplicate grouping via banding (multi-index hashing) + union-find.
 *
 * Splits each 16-hex (64-bit) hash into (threshold+1) nibble-segments. By the
 * pigeonhole principle, any two hashes within `threshold` differing bits must
 * share at least one identical segment, so candidate pairs are exactly those
 * that collide in some segment bucket. Each candidate is verified with the true
 * Hamming distance; verified pairs are unioned. A same-component short-circuit
 * skips verification for pairs already connected (keeps dense buckets cheap).
 *
 * Exact for the given threshold (no missed pairs) as long as segments = threshold+1.
 */
const { hammingDistance } = require('./perceptualHash');

/** Split `total` nibbles into `m` contiguous segments as evenly as possible. */
function segmentRanges(m, total = 16) {
    const ranges = [];
    let start = 0;
    for (let s = 0; s < m; s++) {
        const len = Math.floor(total / m) + (s < (total % m) ? 1 : 0);
        ranges.push([start, len]);
        start += len;
    }
    return ranges;
}

function groupSimilar(items, threshold) {
    const n = items.length;
    const parent = new Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    const m = threshold + 1;
    const ranges = segmentRanges(m);

    // Bucket item indices by (segmentIndex, segmentValue).
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
        const h = items[i].hash;
        for (let s = 0; s < m; s++) {
            const key = s + ':' + h.substr(ranges[s][0], ranges[s][1]);
            let arr = buckets.get(key);
            if (!arr) { arr = []; buckets.set(key, arr); }
            arr.push(i);
        }
    }

    // Verify candidate pairs within each bucket; union those within threshold.
    for (const arr of buckets.values()) {
        if (arr.length < 2) continue;
        for (let a = 0; a < arr.length; a++) {
            const ia = arr[a];
            for (let b = a + 1; b < arr.length; b++) {
                const ib = arr[b];
                if (find(ia) === find(ib)) continue; // already connected — skip
                if (hammingDistance(items[ia].hash, items[ib].hash) <= threshold) union(ia, ib);
            }
        }
    }

    // Collect components of size >= 2.
    const comps = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!comps.has(r)) comps.set(r, []);
        comps.get(r).push(items[i].id);
    }
    const out = [];
    for (const ids of comps.values()) if (ids.length >= 2) out.push(ids);
    return out;
}

module.exports = { groupSimilar, segmentRanges };
```

- [ ] **Step 2: Verify correctness (exactness) on a small crafted set**

Run:
```bash
node -e "
const { groupSimilar } = require('./src/lib/similarGroups.js');
// planted: {1,2,3} within 8 bits; {4,5} within 8 bits; 6 alone
const items = [
  {id:1,hash:'0000000000000000'},
  {id:2,hash:'0000000000000001'},  // 1 bit from 1
  {id:3,hash:'0000000000000003'},  // 2 bits from 1
  {id:4,hash:'ffffffffffffffff'},
  {id:5,hash:'fffffffffffffffe'},  // 1 bit from 4
  {id:6,hash:'0f0f0f0f0f0f0f0f'},  // far from all
];
const g = groupSimilar(items, 8).map(c=>c.sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);
console.log(JSON.stringify(g));
const ok = JSON.stringify(g) === JSON.stringify([[1,2,3],[4,5]]);
console.log(ok ? 'PASS' : 'FAIL');
"
```
Expected: `[[1,2,3],[4,5]]` then `PASS`.

- [ ] **Step 3: Verify exactness vs brute force + scale/timing on 60k synthetic**

Run (planted clusters + noise; cross-check a brute-force reference on a smaller set, then assert 60k completes fast):
```bash
node -e "
const { groupSimilar } = require('./src/lib/similarGroups.js');
const { hammingDistance } = require('./src/lib/perceptualHash.js');
const rndHash=()=>Array.from({length:16},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');

// (a) exactness vs brute force on 800 random items, threshold 8
function brute(items,th){const n=items.length,par=[...Array(n).keys()];const f=x=>{while(par[x]!==x){par[x]=par[par[x]];x=par[x];}return x;};
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(hammingDistance(items[i].hash,items[j].hash)<=th){const a=f(i),b=f(j);if(a!==b)par[a]=b;}
  const cm=new Map();for(let i=0;i<n;i++){const r=f(i);(cm.get(r)||cm.set(r,[]).get(r)).push(items[i].id);}
  return [...cm.values()].filter(c=>c.length>=2).map(c=>c.sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);}
const small=Array.from({length:800},(_,i)=>({id:i,hash:rndHash()}));
const gb=groupSimilar(small,8).map(c=>c.sort((a,b)=>a-b)).sort((a,b)=>a[0]-b[0]);
const bb=brute(small,8);
console.log('exactness vs brute (800):', JSON.stringify(gb)===JSON.stringify(bb)?'PASS':'FAIL');

// (b) scale: 60k items with 2000 planted clusters of 3 near-dups + noise
const big=[]; let id=0;
for(let c=0;c<2000;c++){const base=rndHash(); big.push({id:id++,hash:base});
  for(let k=0;k<2;k++){const arr=base.split(''); const p=Math.floor(Math.random()*16); arr[p]='0123456789abcdef'[Math.floor(Math.random()*16)]; big.push({id:id++,hash:arr.join('')});}}
while(big.length<60000) big.push({id:id++,hash:rndHash()});
const t0=Date.now(); const comps=groupSimilar(big,8); const secs=(Date.now()-t0)/1000;
console.log('60k items grouped in', secs.toFixed(2),'s; components:', comps.length);
console.log('scale time < 30s:', secs<30?'PASS':'FAIL');
"
```
Expected: `exactness vs brute (800): PASS`; a `60k items grouped in <N>s` line; `scale time < 30s: PASS`. (The old BK-tree+BigInt approach would take far longer at this scale — this is the regression gate.)

- [ ] **Step 4: Commit**
```bash
git add src/lib/similarGroups.js
git commit -m "$(printf 'perf: add banding-based scalable similar-image grouping\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Atomic group persist

**Files:** Modify `src/database/db.js` (add `replaceDuplicateGroups` after `insertGroupMembers`, ~line 544)

**Interfaces:**
- Produces: `db.replaceDuplicateGroups(rows)` — DELETE all + INSERT the given rows in a single transaction (atomic swap; never leaves the table empty on failure).

- [ ] **Step 1: Add the method**

In `src/database/db.js`, immediately after the `insertGroupMembers` method (ends ~line 544), add:
```javascript
    /**
     * Atomically replace all duplicate-group rows in a single transaction, so an
     * interrupted detection never leaves the table empty — the previous groups
     * survive until the new set is fully ready.
     */
    replaceDuplicateGroups(rows) {
        const del = this.db.prepare('DELETE FROM duplicate_group_members');
        const ins = this.db.prepare(`
            INSERT OR REPLACE INTO duplicate_group_members
                (group_id, image_id, group_type, is_suggested_keeper, is_oversized, is_auto_eligible)
            VALUES (@groupId, @imageId, @groupType, @isSuggestedKeeper, @isOversized, @isAutoEligible)
        `);
        const tx = this.db.transaction((rs) => {
            del.run();
            for (const r of rs) ins.run(r);
        });
        return tx(rows);
    }
```

- [ ] **Step 2: Verify atomic replace**

Run:
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-replace.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const db=new DB(p);
db.insertGroupMembers([{groupId:1,imageId:1,groupType:'exact',isSuggestedKeeper:1,isOversized:0,isAutoEligible:1}]);
console.log('before:', db.db.prepare('SELECT COUNT(*) c FROM duplicate_group_members').get().c);
db.replaceDuplicateGroups([
  {groupId:1,imageId:5,groupType:'similar',isSuggestedKeeper:1,isOversized:0,isAutoEligible:0},
  {groupId:1,imageId:6,groupType:'similar',isSuggestedKeeper:0,isOversized:0,isAutoEligible:0}
]);
const rows=db.db.prepare('SELECT image_id FROM duplicate_group_members ORDER BY image_id').all().map(r=>r.image_id);
console.log('after:', JSON.stringify(rows), JSON.stringify(rows)===JSON.stringify([5,6])?'PASS':'FAIL');
// empty replace clears
db.replaceDuplicateGroups([]);
console.log('empty replace:', db.db.prepare('SELECT COUNT(*) c FROM duplicate_group_members').get().c, '(exp 0)');
"
```
Expected: `before: 1`, `after: [5,6] PASS`, `empty replace: 0 (exp 0)`.

- [ ] **Step 3: Commit**
```bash
git add src/database/db.js
git commit -m "$(printf 'fix: atomic replaceDuplicateGroups so interrupted scans keep prior results\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Rewire detection to use banding + atomic persist

**Files:** Modify `src/services/duplicateDetection.js` (imports line 3; `_detectGroups` lines 67-131); Delete `src/lib/bkTree.js`

- [ ] **Step 1: Swap the BK-tree import for the banding module**

In `src/services/duplicateDetection.js`, replace line 3:
```javascript
const BKTree = require('../lib/bkTree');
```
with:
```javascript
const { groupSimilar } = require('../lib/similarGroups');
```

- [ ] **Step 2: Remove the up-front clear**

In `_detectGroups`, delete line 68:
```javascript
        this.db.clearDuplicateGroups();
```
(The atomic replace at the end now handles clearing.)

- [ ] **Step 3: Replace the BK-tree grouping block with banding**

Replace the block (duplicateDetection.js lines 92-112) — from `const tree = new BKTree(hammingDistance);` through the `components` Map construction:
```javascript
        const tree = new BKTree(hammingDistance);
        for (const r of rows) tree.insert(r.perceptual_hash, r.id);

        const parent = new Map();
        const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        const union = (a, b) => { parent.set(find(a), find(b)); };
        for (const r of rows) parent.set(r.id, r.id);

        for (const r of rows) {
            const neighbors = tree.query(r.perceptual_hash, threshold);
            for (const n of neighbors) {
                if (n.value !== r.id) union(r.id, n.value);
            }
        }

        const components = new Map();
        for (const r of rows) {
            const root = find(r.id);
            if (!components.has(root)) components.set(root, []);
            components.get(root).push(r.id);
        }
```
with:
```javascript
        const components = groupSimilar(
            rows.map(r => ({ id: r.id, hash: r.perceptual_hash })),
            threshold
        );
```

- [ ] **Step 4: Iterate the returned components array**

The next block iterates `components.values()` (a Map). Since `groupSimilar` returns an **array of id-arrays**, change (duplicateDetection.js ~line 115):
```javascript
        for (const ids of components.values()) {
```
to:
```javascript
        for (const ids of components) {
```

- [ ] **Step 5: Persist atomically**

Replace the final line (duplicateDetection.js ~line 130):
```javascript
        if (memberRows.length) this.db.insertGroupMembers(memberRows);
```
with:
```javascript
        // Atomic swap: prior groups survive until the new set is fully built.
        this.db.replaceDuplicateGroups(memberRows);
```
(Always call it — an empty `memberRows` correctly clears to "no duplicates".)

- [ ] **Step 6: Delete the now-unused BK-tree**
```bash
git rm src/lib/bkTree.js
```

- [ ] **Step 7: Verify end-to-end detection (correctness) + no BKTree refs**

Run (seeds exact + similar + unique with crafted hashes; confirms groups + atomic persist path):
```bash
grep -rn "bkTree\|BKTree" src/ && echo "FAIL: BKTree refs remain" || echo "PASS: no BKTree refs"
node --check src/services/duplicateDetection.js && echo "PARSE OK"
node -e "
const fs=require('fs'); const p='/tmp/pf-detect2.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const Svc=require('./src/services/duplicateDetection.js');
const db=new DB(p); const now=Date.now();
function ins(fp,ch,ph,w){db.insertImage({filepath:fp,filename:fp,fileModified:now,width:w,height:w});const r=db.getImageByPath(fp);db.setHashes(r.id,ch,ph);}
ins('/a','H1','0000000000000000',100); ins('/b','H1','0000000000000000',200);   // exact pair
ins('/c','H2','0000000000000010',100); ins('/d','H3','0000000000000011',100);   // similar pair (1 bit)
ins('/e','H4','ffffffffffffffff',100);                                          // unique
const svc=new Svc(db,{duplicates:{similarThreshold:8,similarAutoThreshold:5,maxGroupSize:25}},{});
svc._detectGroups();
const s=db.getDuplicateGroupSummary();
console.log('summary:', JSON.stringify(s), (s.exactGroups===1 && s.similarGroups===1)?'PASS':'FAIL');
const ex=db.getDuplicateGroups().find(g=>g.groupType==='exact');
const keeper=ex.members.find(m=>m.isSuggestedKeeper);
console.log('exact keeper bigger res:', keeper.width===200?'PASS':'FAIL');
"
```
Expected: `PASS: no BKTree refs`, `PARSE OK`, `summary: {"exactGroups":1,"similarGroups":1} PASS`, `exact keeper bigger res: PASS`.

- [ ] **Step 8: Commit**
```bash
git add src/services/duplicateDetection.js src/lib/bkTree.js
git commit -m "$(printf 'perf: detect similar dups via banding + atomic persist; drop BK-tree\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Lower the default similar threshold

**Files:** Modify `config.json`

- [ ] **Step 1: Change the default**

In `config.json`, in the `duplicates` block, change `"similarThreshold": 10,` to `"similarThreshold": 8,`. Leave `similarAutoThreshold: 5`, `maxGroupSize: 25`, `hashBatchSize: 100`.

- [ ] **Step 2: Verify**
```bash
node -e "const c=require('./src/config.js').loadConfig(); console.log(c.duplicates.similarThreshold, c.duplicates.similarThreshold===8?'PASS':'FAIL')"
```
Expected: `8 PASS`.

- [ ] **Step 3: Commit**
```bash
git add config.json
git commit -m "$(printf 'chore: default similarThreshold 10 -> 8 (tighter, faster banding)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: Large-scale end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Prove full detection is fast on a 100k synthetic DB**

Run (seeds a temp DB with 100k images + planted clusters, runs the real `_detectGroups`, asserts it completes in well under the old ~4.8h — target < 60s — and finds groups):
```bash
node -e "
const fs=require('fs'); const p='/tmp/pf-scale.db';
for (const f of [p,p+'-wal',p+'-shm']){try{fs.unlinkSync(f)}catch(_){}}
const DB=require('./src/database/db.js'); const Svc=require('./src/services/duplicateDetection.js');
const db=new DB(p); const now=Date.now();
const rndHash=()=>Array.from({length:16},()=>'0123456789abcdef'[Math.floor(Math.random()*16)]).join('');
const ins=db.db.prepare('INSERT INTO images (filepath,filename,file_modified,date_added,width,height,content_hash,perceptual_hash,hash_computed,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)');
const tx=db.db.transaction(()=>{ let id=0;
  for(let c=0;c<3000;c++){const base=rndHash(); for(let k=0;k<3;k++){const a=base.split(''); if(k){const pos=Math.floor(Math.random()*16); a[pos]='0123456789abcdef'[Math.floor(Math.random()*16)];} const h=a.join(''); ins.run('/p'+id, 'p'+id, now, now, 100+ (id%50), 100, null, h, now, now); id++; }}
  while(id<100000){ ins.run('/p'+id,'p'+id,now,now,100,100,null,rndHash(),now,now); id++; }
});
tx();
console.log('seeded', db.getImagesCount(), 'images');
const svc=new Svc(db,{duplicates:{similarThreshold:8,similarAutoThreshold:5,maxGroupSize:25}},{});
const t0=Date.now(); svc._detectGroups(); const secs=(Date.now()-t0)/1000;
console.log('detect took', secs.toFixed(2),'s; summary:', JSON.stringify(db.getDuplicateGroupSummary()));
console.log('under 60s:', secs<60?'PASS':'FAIL');
db.close();
"
```
Expected: `seeded 100000 images`, a `detect took <N>s` line (should be seconds, not hours), a summary with a few thousand similar groups, and `under 60s: PASS`.

- [ ] **Step 2: Confirm no regressions in the touched files**
```bash
for f in src/lib/perceptualHash.js src/lib/similarGroups.js src/database/db.js src/services/duplicateDetection.js; do node --check "$f" && echo "$f OK"; done
node -e "JSON.parse(require('fs').readFileSync('config.json')); console.log('config valid')"
```
Expected: all `OK` + `config valid`.

## Self-Review notes

- **Root cause addressed:** integer Hamming (T1) + banding replacing the BK-tree (T2,T4) kills the O(n²)/BigInt blowup; atomic `replaceDuplicateGroups` (T3,T4) removes the all-or-nothing-wipe hazard.
- **Exactness:** banding uses `threshold+1` segments → pigeonhole guarantees no missed pairs vs. the old semantics (verified by the brute-force cross-check in T2 Step 3).
- **Consumers unchanged:** `hammingDistance` signature identical; `_connectedAtThreshold` (still used for autoEligible) now benefits from the fast Hamming; routes/UI untouched.
- **Deploy note (post-merge):** on the mini, a re-scan will now complete quickly and repopulate groups; the atomic persist means the existing 45,099 group rows remain until the new scan's results are ready.
