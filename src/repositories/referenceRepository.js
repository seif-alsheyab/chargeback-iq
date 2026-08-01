// Reads of reference data: network rules that rarely change.
//
// Every function takes `db` first. That can be the pool (normal use) or a
// single client inside a transaction (tests, multi-step writes). The
// function neither knows nor cares which -- exactly why it is easy to test.

export async function listStatusTransitions(db) {
  const { rows } = await db.query(
    `SELECT from_status, to_status, triggered_by, requires_evidence, description
       FROM status_transitions
      ORDER BY from_status, to_status`
  );
  return rows;
}

export async function listDeadlineRules(db) {
  const { rows } = await db.query(
    `SELECT network_code, stage, region, processor_code, response_days, warn_days_before
       FROM deadline_rules`
  );
  return rows;
}

export async function listStatuses(db) {
  const { rows } = await db.query(
    `SELECT code, name, description, is_terminal, is_won, sort_order
       FROM dispute_statuses
      ORDER BY sort_order`
  );
  return rows;
}

export async function findReasonCode(db, networkCode, code) {
  // Parameters go in as $1/$2, never string-concatenated into the SQL.
  // Concatenation is how SQL injection happens; the driver sends parameters
  // separately from the statement so user input can never become code.
  const { rows } = await db.query(
    `SELECT rc.id, rc.network_code, rc.code, rc.title, rc.category_code,
            rc.workflow, rc.evidence_guidance, dc.counts_as_fraud
       FROM reason_codes rc
       JOIN dispute_categories dc ON dc.code = rc.category_code
      WHERE rc.network_code = $1 AND rc.code = $2`,
    [networkCode, code]
  );
  return rows[0] ?? null;
}

export async function listEvidenceRequirements(db, reasonCodeId) {
  const { rows } = await db.query(
    `SELECT er.evidence_kind_code, er.requirement, ek.name, ek.description
       FROM evidence_requirements er
       JOIN evidence_kinds ek ON ek.code = er.evidence_kind_code
      WHERE er.reason_code_id = $1
      ORDER BY CASE er.requirement
                 WHEN 'REQUIRED' THEN 1 WHEN 'RECOMMENDED' THEN 2 ELSE 3 END,
               ek.name`,
    [reasonCodeId]
  );
  return rows;
}
