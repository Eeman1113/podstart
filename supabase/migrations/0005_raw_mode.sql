-- Raw mode.
--
-- A take can be marked raw, meaning nothing is ever applied to its samples:
-- no denoise, no dereverb, no loudness normalisation, no limiter, no trim,
-- and no drift resampling. The stems come out of podstart bit-identical to
-- what the microphones produced, and alignment is delivered as numbers in a
-- sidecar file for you to apply in your own editor.
--
-- This is the honest option for anyone who wants to do their own post, and
-- the reference to compare the cleaned version against.

alter table sessions
  add column if not exists processing text not null default 'clean'
    check (processing in ('clean', 'raw'));

comment on column sessions.processing is
  'clean = cleanup chain and mastering allowed; raw = samples are never altered.';
