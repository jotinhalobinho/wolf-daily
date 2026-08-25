SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS sectors (
  id         VARCHAR(64) PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  color      VARCHAR(7) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_sector_name UNIQUE (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS collaborators (
  id         VARCHAR(64) PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  role       VARCHAR(100) NOT NULL,
  sector_id  VARCHAR(64) NULL,
  hire_date  DATE NULL,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  birth_date DATE NULL,
  salary     DECIMAL(12,2) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_collaborators_sector
    FOREIGN KEY (sector_id) REFERENCES sectors(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(100) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  role            ENUM('admin','collaborator') NOT NULL,
  collaborator_id VARCHAR(64) NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_collaborator
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS releases (
  id           VARCHAR(64) PRIMARY KEY,
  month        INT NOT NULL,
  year         INT NOT NULL,
  working_days INT NOT NULL,
  deadline     VARCHAR(50) DEFAULT '',
  status       ENUM('open','approved') NOT NULL DEFAULT 'open',
  approved_at  DATETIME NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rateio_entries (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  release_id      VARCHAR(64) NOT NULL,
  collaborator_id VARCHAR(64) NOT NULL,
  observations    VARCHAR(1000) DEFAULT '',
  submitted       TINYINT(1) DEFAULT 0,
  CONSTRAINT uq_release_collaborator UNIQUE (release_id, collaborator_id),
  CONSTRAINT fk_entries_release
    FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
  CONSTRAINT fk_entries_collaborator
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rateio_entry_items (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  entry_id   INT NOT NULL,
  unit       VARCHAR(50),
  name       VARCHAR(255) NOT NULL,
  days       INT NOT NULL DEFAULT 0,
  operations VARCHAR(255) NULL,
  CONSTRAINT fk_items_entry
    FOREIGN KEY (entry_id) REFERENCES rateio_entries(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS projects (
  id           VARCHAR(64) PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  description  VARCHAR(1000) DEFAULT '',
  requester    VARCHAR(255) DEFAULT '',
  month        INT NOT NULL,
  year         INT NOT NULL,
  start_date   VARCHAR(50) DEFAULT '',
  end_date     VARCHAR(50) DEFAULT '',
  cost_centers JSON NOT NULL,
  splits       JSON NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS project_members (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  project_id      VARCHAR(64) NOT NULL,
  collaborator_id VARCHAR(64) NOT NULL,
  days            INT NOT NULL DEFAULT 0,
  CONSTRAINT uq_project_collaborator UNIQUE (project_id, collaborator_id),
  CONSTRAINT fk_members_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_members_collaborator
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  `key`  VARCHAR(100) PRIMARY KEY,
  value  TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_periods (
  id         VARCHAR(64) PRIMARY KEY,
  user_id    INT NOT NULL,
  month      INT NOT NULL,
  year       INT NOT NULL,
  status     ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at  DATETIME NULL,
  CONSTRAINT uq_user_month_year UNIQUE (user_id, month, year),
  CONSTRAINT fk_periods_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_days (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  period_id         VARCHAR(64) NOT NULL,
  date              DATE NOT NULL,
  holiday_name      VARCHAR(255) NULL,
  holiday_override  TINYINT(1) NULL,
  atestado          TINYINT(1) NOT NULL DEFAULT 0,
  day_off           TINYINT(1) NOT NULL DEFAULT 0,
  CONSTRAINT uq_period_date UNIQUE (period_id, date),
  CONSTRAINT fk_days_period
    FOREIGN KEY (period_id) REFERENCES daily_periods(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_day_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  day_id       INT NOT NULL,
  unit         ENUM('wolf','fraga','woncred','profit','geral') NOT NULL,
  project_name VARCHAR(255) NOT NULL,
  operations   VARCHAR(255) NULL,
  CONSTRAINT fk_day_items_day
    FOREIGN KEY (day_id) REFERENCES daily_days(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ho_periods (
  id          VARCHAR(64) PRIMARY KEY,
  month       INT NOT NULL,
  year        INT NOT NULL,
  deadline    VARCHAR(50) DEFAULT '',
  status      ENUM('open','approved') NOT NULL DEFAULT 'open',
  approved_at DATETIME NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ho_period_month_year UNIQUE (month, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ho_entries (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  period_id       VARCHAR(64) NOT NULL,
  collaborator_id VARCHAR(64) NOT NULL,
  date            DATE NOT NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ho_entry UNIQUE (period_id, collaborator_id, date),
  CONSTRAINT fk_ho_entries_period
    FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE,
  CONSTRAINT fk_ho_entries_collaborator
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ho_special_days (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  period_id       VARCHAR(64) NOT NULL,
  collaborator_id VARCHAR(64) NOT NULL,
  date            DATE NOT NULL,
  type            ENUM('ferias','dayoff') NOT NULL,
  CONSTRAINT uq_ho_special_day UNIQUE (period_id, collaborator_id, date),
  CONSTRAINT fk_ho_special_period
    FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE,
  CONSTRAINT fk_ho_special_collaborator
    FOREIGN KEY (collaborator_id) REFERENCES collaborators(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ho_general_meetings (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  period_id  VARCHAR(64) NOT NULL,
  date       DATE NOT NULL,
  title      VARCHAR(255) DEFAULT '',
  CONSTRAINT uq_ho_meeting_date UNIQUE (period_id, date),
  CONSTRAINT fk_ho_meeting_period
    FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Troca de feriado: o feriado (holiday_date) vira dia útil (trabalhado) e o
-- dia escolhido (compensation_date) vira a folga no lugar dele — ninguém
-- trabalha nele, nem presencial nem home office.
CREATE TABLE IF NOT EXISTS ho_holiday_overrides (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  period_id         VARCHAR(64) NOT NULL,
  holiday_date      DATE NOT NULL,
  compensation_date DATE NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_ho_override_holiday UNIQUE (period_id, holiday_date),
  CONSTRAINT uq_ho_override_compensation UNIQUE (period_id, compensation_date),
  CONSTRAINT fk_ho_override_period
    FOREIGN KEY (period_id) REFERENCES ho_periods(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
