-- Extracted evidence needs human approval before the drafter can use it --
-- same shadow-then-ratify shape as profiles. Manually `foghorn evidence add`
-- entries are an explicit human act already, so they default straight in.
ALTER TABLE evidence_bank ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE evidence_bank ADD COLUMN source_quote TEXT;
ALTER TABLE evidence_bank ADD COLUMN source_doc_id INTEGER;

CREATE INDEX idx_evidence_bank_status ON evidence_bank(status);
