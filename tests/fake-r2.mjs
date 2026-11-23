/**
 * 記憶體版的 R2（BACKUPS 儲存桶）。put／get／delete／list（含 prefix、limit、cursor）。
 * 與 tests/backup.test.mjs 裡那一份的差別：多了 get 與 cursor，給版本歷史的測試用（那邊要讀回內容、要分頁清 prefix）。
 * 這裡要驗的是**我們寫進去什麼、讀回什麼、清掉哪些**，不是 R2 本身——所以假物件剛好夠
 * （與 d1.mjs 用真 SQLite 的理由剛好相反：SQL 的語意不能自己造）。
 * failPut／failDelete／failList 讓測試把「R2 出事」做成確定性的。
 */
export function fakeR2() {
  const store = new Map();
  const r2 = {
    store, failPut: false, failDelete: false, failList: false,
    async put(key, body, opts) {
      if (r2.failPut) throw new Error('R2 put 失敗（測試注入）');
      store.set(key, { body: String(body), opts });
    },
    async get(key) {
      const v = store.get(key);
      return v ? { text: async () => v.body, body: v.body } : null;
    },
    async delete(key) {
      if (r2.failDelete) throw new Error('R2 delete 失敗（測試注入）');
      store.delete(key);
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      if (r2.failList) throw new Error('R2 list 失敗（測試注入）');
      const all = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? parseInt(cursor, 10) : 0;
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return {
        objects: page.map(key => ({ key, size: store.get(key).body.length, uploaded: new Date(0), customMetadata: store.get(key).opts?.customMetadata })),
        truncated, ...(truncated ? { cursor: String(start + limit) } : {}),
      };
    },
  };
  return r2;
}
