import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

class Statement {
  constructor(db,sql,bindings=[]){Object.assign(this,{db,sql,bindings});}
  bind(...bindings){return new Statement(this.db,this.sql,bindings);}
  first(){return this.db.raw.prepare(this.sql).get(...this.bindings)??null;}
  all(){return {success:true,results:this.db.raw.prepare(this.sql).all(...this.bindings)};}
  run(){const r=this.db.raw.prepare(this.sql).run(...this.bindings);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
}
export class UiSQLiteD1 {
  constructor(){this.raw=new DatabaseSync(':memory:');this.raw.exec('PRAGMA foreign_keys=ON');this.beforeBatch=null;}
  prepare(sql){return new Statement(this,sql);}
  async batch(statements){
    if(this.beforeBatch) await this.beforeBatch(statements);
    this.raw.exec('BEGIN IMMEDIATE');
    try{const results=statements.map(s=>s.run());this.raw.exec('COMMIT');return results;}
    catch(error){this.raw.exec('ROLLBACK');throw error;}
  }
  migrate(name){this.raw.exec(readFileSync(new URL(`../../migrations/${name}`,import.meta.url),'utf8'));}
  close(){this.raw.close();}
}
