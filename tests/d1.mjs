/**
 * 用 node:sqlite（Node 內建，不是相依套件）搭一個最小的 D1 相容外殼，讓
 * Worker 端的 handler 可以直接在測試裡跑真正的 SQL。
 *
 * 為什麼不用假的 DB 物件：這一批測試要驗證的正是「帶條件的 UPDATE 有沒有改到
 * 一列」——那是 SQL 的語意，自己造一個假物件等於把要驗的東西寫成期望值，
 * 測起來永遠會過。真的 SQLite 才問得出真的答案。
 *
 * 只實作 handler 實際用到的介面：prepare().bind().run()/first()/all() 與 batch()。
 * D1 的 run() 回 { meta:{ changes } }，node:sqlite 回 { changes }，差異在此弭平。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) {
    // D1 拒絕 undefined；把它當成呼叫端的錯誤而不是靜默轉 null，
    // 否則正式環境才會炸的那種 bug 在測試裡看不出來。
    args.forEach((a, i) => {
      if (a === undefined) throw new TypeError(`bind(): 第 ${i + 1} 個參數是 undefined`);
    });
    const s = new Stmt(this.db, this.sql);
    s.args = args;
    return s;
  }
  run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
  first() {
    const r = this.db.prepare(this.sql).get(...this.args);
    return r === undefined ? null : r;
  }
  all() {
    return { success: true, results: this.db.prepare(this.sql).all(...this.args) };
  }
}

/** 回傳一個 env 形狀的物件（handler 拿到的是 env.DB，不是裸的資料庫） */
export function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const DB = {
    prepare(sql) { return new Stmt(db, sql); },
    // D1 的 batch 是單一交易；這裡照樣包成交易，讓「其中一句失敗要整批回滾」
    // 的行為與正式環境一致。
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map(s => s.run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
  };
  return { DB };
}

/** 建一個已核准的使用者，回傳 id */
export function addUser(env, id, email, role = 'user') {
  env.DB.prepare('INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, email, 'x', role, 'approved', 0).run();
  return id;
}

/** 直接塞一份雲端 state，回傳它的 updated_at（＝版本號） */
export function seedState(env, userId, state, updatedAt) {
  env.DB.prepare('INSERT INTO user_state (user_id, state, updated_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(userId, JSON.stringify(state), updatedAt, updatedAt).run();
  return updatedAt;
}

export function readState(env, userId) {
  const row = env.DB.prepare('SELECT state, updated_at FROM user_state WHERE user_id = ?').bind(userId).first();
  return row ? { state: JSON.parse(row.state), updatedAt: row.updated_at } : null;
}

/** 把 handler 回傳的 Response 拆成 { status, body } */
export async function unwrap(res) {
  return { status: res.status, body: await res.json() };
}

/** 造一個帶 JSON body 的 Request */
export function req(body) {
  return new Request('https://example.test/api/state', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}
