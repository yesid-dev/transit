# STM and OC Transpo clean measure samples

Contains data from the Société de transport de Montréal (STM), made available
under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
[STM open data](https://www.stm.info/a-propos/documents-donnees/donnees-ouvertes)

Contains information licensed under the Open Government Licence – City of Ottawa.
[City of Ottawa licence](https://ottawa.ca/en/city-hall/open-transparent-and-accountable-government/open-data/open-data-licence-version-20)

These are extracts of the `stm/2026-11-20/v11/` and
`octranspo/2026-11-20/v11/` objects in the `transit-clean` bucket.
They cover STM route 51 and vehicle 41027, and OC Transpo route 75 and vehicle
6417. The original objects matched the hashes in the published manifests.
The fixture manifests retain the source schedule hash and cleaning build
identity and record the row counts, sizes and hashes of the extracts.

- Stop events and scheduled stop times include all rows on the selected line.
- Trip days include the selected line and trips associated with the selected
  vehicle by a trip row or vehicle position.
- Vehicle positions include the selected vehicle's full timeline and all
  positions on the selected line. The immediate successor of each line
  position preserves its original time bound when the vehicle changes lines.
  The vehicle tracking gate in the extract uses this retained population.
- Feed polls are unchanged. The engine uses them for capture coverage and
  the open-data scorecard. STM alerts retain notices whose route IDs include
  line 51. OC Transpo's manifest records alerts as untracked.
- Prediction samples retain the Parquet schema with zero rows to complete
  the v11 manifest. The scorecard check exercises poll success.
