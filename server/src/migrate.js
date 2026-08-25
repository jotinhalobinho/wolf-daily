"use strict";

const db = require("./db");

// Pequenas migrações que rodam sozinhas toda vez que o servidor sobe — como
// não existe uma ferramenta de migração no projeto (o schema é só um arquivo
// SQL importado manualmente na primeira instalação), qualquer coluna nova
// precisa ser adicionada aqui também, senão quem já tem o banco criado nunca
// vai ganhar a coluna nova só rodando `mysql_schema.sql` de novo (o `CREATE
// TABLE IF NOT EXISTS` não altera tabelas que já existem).

async function columnExists(table, column) {
  const row = await db.get(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return row.cnt > 0;
}

async function constraintExists(table, constraintName) {
  const row = await db.get(
    `SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, constraintName]
  );
  return row.cnt > 0;
}

async function runMigrations() {
  // Escala de Home Office — tabelas novas (quem já tem o banco criado antes
  // dessa feature não ganha essas tabelas só rodando mysql_schema.sql de novo).
  await db.run(`CREATE TABLE IF NOT EXISTS sectors (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    color VARCHAR(7) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_sector_name UNIQUE (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS ho_periods (
    id VARCHAR(64) PRIMARY KEY, month INT NOT NULL, year INT NOT NULL,
    deadline VARCHAR(50) DEFAULT '', status ENUM('open','approved') NOT NULL DEFAULT 'open',
    approved_at DATETIME NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ho_period_month_year UNIQUE (month, year)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS ho_entries (
    id INT AUTO_INCREMENT PRIMARY KEY, period_id VARCHAR(64) NOT NULL,
    collaborator_id VARCHAR(64) NOT NULL, date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ho_entry UNIQUE (period_id, collaborator_id, date),
    CONSTRAINT fk_ho_entries_period FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE,
    CONSTRAINT fk_ho_entries_collaborator FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS ho_special_days (
    id INT AUTO_INCREMENT PRIMARY KEY, period_id VARCHAR(64) NOT NULL,
    collaborator_id VARCHAR(64) NOT NULL, date DATE NOT NULL, type ENUM('ferias','dayoff') NOT NULL,
    CONSTRAINT uq_ho_special_day UNIQUE (period_id, collaborator_id, date),
    CONSTRAINT fk_ho_special_period FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE,
    CONSTRAINT fk_ho_special_collaborator FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await db.run(`CREATE TABLE IF NOT EXISTS ho_general_meetings (
    id INT AUTO_INCREMENT PRIMARY KEY, period_id VARCHAR(64) NOT NULL,
    date DATE NOT NULL, title VARCHAR(255) DEFAULT '',
    CONSTRAINT uq_ho_meeting_date UNIQUE (period_id, date),
    CONSTRAINT fk_ho_meeting_period FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Troca de feriado: holiday_date vira dia útil (trabalhado), compensation_date
  // vira a folga no lugar dele.
  await db.run(`CREATE TABLE IF NOT EXISTS ho_holiday_overrides (
    id INT AUTO_INCREMENT PRIMARY KEY, period_id VARCHAR(64) NOT NULL,
    holiday_date DATE NOT NULL, compensation_date DATE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_ho_override_holiday UNIQUE (period_id, holiday_date),
    CONSTRAINT uq_ho_override_compensation UNIQUE (period_id, compensation_date),
    CONSTRAINT fk_ho_override_period FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Escala de Home Office — setor, data de admissão (define a cota semanal
  // automática) e se o colaborador está ativo (conta pro mínimo presencial
  // do setor). Ver server/src/homeOfficeRules.js.
  if (!(await columnExists("collaborators", "sector_id"))) {
    await db.run("ALTER TABLE collaborators ADD COLUMN sector_id VARCHAR(64) NULL AFTER role");
    console.log("  [migração] coluna collaborators.sector_id criada.");
  }
  if (!(await columnExists("sectors", "color"))) {
    await db.run("ALTER TABLE sectors ADD COLUMN color VARCHAR(7) NULL AFTER name");
    console.log("  [migração] coluna sectors.color criada.");
  }
  // A cor da tag na Escala de Home Office passou a ser do setor, não mais do
  // colaborador individualmente — remove a coluna antiga se alguém já tinha
  // rodado uma versão anterior desta migração.
  if (await columnExists("collaborators", "color")) {
    await db.run("ALTER TABLE collaborators DROP COLUMN color");
    console.log("  [migração] coluna collaborators.color removida (cor agora é do setor).");
  }
  if (!(await columnExists("collaborators", "hire_date"))) {
    await db.run("ALTER TABLE collaborators ADD COLUMN hire_date DATE NULL AFTER sector_id");
    console.log("  [migração] coluna collaborators.hire_date criada.");
  }
  if (!(await columnExists("collaborators", "active"))) {
    await db.run("ALTER TABLE collaborators ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER hire_date");
    console.log("  [migração] coluna collaborators.active criada.");
  }
  // Estagiários não têm direito a home office, independente do tempo de
  // casa — checado em POST /home-office/.../entries, ver homeOffice.js.
  if (!(await columnExists("collaborators", "is_intern"))) {
    await db.run("ALTER TABLE collaborators ADD COLUMN is_intern TINYINT(1) NOT NULL DEFAULT 0 AFTER active");
    console.log("  [migração] coluna collaborators.is_intern criada.");
  }
  if (!(await constraintExists("collaborators", "fk_collaborators_sector"))) {
    await db.run(
      "ALTER TABLE collaborators ADD CONSTRAINT fk_collaborators_sector FOREIGN KEY (sector_id) REFERENCES sectors(id) ON DELETE SET NULL"
    );
    console.log("  [migração] FK collaborators.sector_id -> sectors criada.");
  }

  // Data de aniversário do colaborador (opcional) — usada pra descontar 1 dia
  // (day off) do rateio mensal no mês em que ela cai.
  if (!(await columnExists("collaborators", "birth_date"))) {
    await db.run("ALTER TABLE collaborators ADD COLUMN birth_date DATE NULL AFTER role");
    console.log("  [migração] coluna collaborators.birth_date criada.");
  }

  // Day off de aniversário: um único dia por mês, marcado no Rateio Diário,
  // que some as horas sem centro de custo (ver [[daily-suggestion-feature]]).
  if (!(await columnExists("daily_days", "day_off"))) {
    await db.run("ALTER TABLE daily_days ADD COLUMN day_off TINYINT(1) NOT NULL DEFAULT 0 AFTER atestado");
    console.log("  [migração] coluna daily_days.day_off criada.");
  }

  // Amplia o centro de custo do rateio diário para aceitar "geral" (demanda
  // que não precisa ser lançada num centro de custo específico).
  const unitColumn = await db.get(
    `SELECT COLUMN_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'daily_day_items' AND COLUMN_NAME = 'unit'`
  );
  if (unitColumn && !unitColumn.type.includes("'geral'")) {
    await db.run(
      "ALTER TABLE daily_day_items MODIFY COLUMN unit ENUM('wolf','fraga','woncred','profit','geral') NOT NULL"
    );
    console.log("  [migração] daily_day_items.unit agora aceita 'geral'.");
  }

  // Força a troca de senha no primeiro login (senha inicial/redefinida sempre
  // é o padrão "wolf360" — ver server/src/auth.js DEFAULT_PASSWORD).
  if (!(await columnExists("users", "must_change_password"))) {
    await db.run("ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER password_hash");
    console.log("  [migração] coluna users.must_change_password criada.");
  }
}

module.exports = { runMigrations };
