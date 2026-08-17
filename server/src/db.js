"use strict";

require("dotenv").config();
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "rateio_horas",
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true, // devolve DATE/DATETIME como string 'YYYY-MM-DD...', igual o SQLite fazia
});

// Camada de compatibilidade com o estilo antigo (better-sqlite3, síncrono).
// Agora tudo retorna Promise, porque o MySQL conversa com o banco pela rede
// — todo lugar que antes usava db.prepare(sql).get()/.all()/.run() agora usa
// await db.get(sql, params) / db.all(sql, params) / db.run(sql, params).

async function get(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0];
}

async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return { lastInsertRowid: result.insertId, changes: result.affectedRows };
}

// Colunas JSON (cost_centers, splits) podem voltar como string ou já como
// objeto/array dependendo da versão do driver — essa função aceita os dois
// formatos com segurança, em vez de assumir sempre string como no SQLite.
function parseJSON(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

module.exports = { pool, get, all, run, parseJSON };
