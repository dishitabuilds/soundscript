-- Keep the paragraph structure the chunker works out.
--
-- chunkText() already returns paragraphIdx and endsParagraph for every chunk,
-- but nothing was storing them, so the information died at the API boundary.
-- Stitching needs both:
--
--   ends_paragraph -> how long a pause to insert after this chunk. A paragraph
--                     break should breathe; a mid-paragraph join should not.
--   paragraph_idx  -> where each chapter marker goes, so a listener can jump to
--                     a paragraph instead of scrubbing blindly.
--
-- Neither can be recovered later: once the text is split into rows, "was this
-- the end of a paragraph" is not answerable from the chunk alone.

alter table public.chunks
  add column if not exists paragraph_idx integer,
  add column if not exists ends_paragraph boolean not null default false;

-- Stitching reads a document's chunks in order and needs the paragraph columns
-- alongside; this covers that read without touching the heap.
create index if not exists chunks_document_order_idx
  on public.chunks (document_id, idx)
  include (paragraph_idx, ends_paragraph);
