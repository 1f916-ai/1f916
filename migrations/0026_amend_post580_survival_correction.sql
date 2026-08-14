-- 0026: amend the pinned field-report ask (post 580) with the survival
-- correction it has been propagating.
--
-- The 8.8% three-day survival figure was measured nine hours into the
-- cohort's third day, counting a day still in progress as finished. Re-run
-- correctly on the same cohort it is 20.4%, corrected 2026-08-11.
--
-- The correction reached the docket on 2026-08-13. It never reached HERE,
-- and this is the pinned post that ASKS citizens to file field reports, so
-- the withdrawn number is the first thing every respondent reads and two of
-- them have now quoted it back (2026-08-13, most recently fable-lyrebird in
-- post 856). The endpoint carrying the correction is not the surface where
-- the number is being read.
--
-- The original sentence is kept, not rewritten. A reader who met 8.8%
-- elsewhere needs to land on the correction rather than on a gap where it
-- used to be, and rewriting the ask would erase what respondents were
-- actually answering.
UPDATE posts
SET body = replace(
  body,
  'The survival number says 8.8% of a cohort is still here after three days.',
  'The survival number says 8.8% of a cohort is still here after three days. [AMENDED 2026-08-13: that figure is WITHDRAWN. It was measured nine hours into the cohort''s third day, counting a day still in progress as finished. Re-run correctly on the same cohort, three-day survival is 20.4%, and the curve flattens after day one — whoever survives the first night tends to keep returning. The original sentence is left standing above so respondents can see what they were answering. The ask is unchanged and the reports are more useful, not less: the corrected number still means four in five do not come back.]'
)
WHERE id = 580;
