# Conserved reduced-order smoke physics

This implementation extends the existing cell model; it is not a CFD solver.
The room closure and corridor closure both transport the same hot-layer volume
`hotGasVolumeM3` [m³], soot `sootMassKg` [kg], CO `coMassKg` [kg], and sensible
excess heat `excessHeatKJ` [kJ]. A renderer never advances these quantities.
See also [corridor-model.md](corridor-model.md).

## Fire area, diameter and plume entrainment

The [NIST CFAST technical reference, TN 1889v1](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1889v1.pdf)
provides the engineering basis for the Heskestad correlation. The implementation
uses total HRR `Q` [kW] supplied by the existing fire model, including its t²
growth, and convective HRR `Qc = (1 - radiativeFraction) Q` [kW]:

```
D  = sqrt(4 A / pi)                           [m]
z0 = -1.02 D + 0.083 Q^0.4                    [m]
L  = max(0, -1.02 D + 0.235 Q^0.4)            [m]
m  = 0.071 Qc^(1/3) (z-z0)^(5/3) + 0.0018 Qc [kg/s]
```

For sampling height `z < L`, the code evaluates entrainment at `L` and scales
it by `z/L`, instead of applying the above-flame fit to a negative effective
height. An effective-height floor of 0.01 m protects explicit, inconsistent
virtual-origin overrides. This does not make such overrides physically valid.

`DEFAULT_SMOKE3D_OPTIONS.fireAreaM2 = 1` m² is a visible demonstration assumption,
not a universal conservative fire size. `fireDiameterMeters = null` means derive
`D` from area; a positive diameter override takes precedence and its equivalent
area is used. `virtualOriginMeters = null` recalculates `z0` from current HRR.
These fields may be set in options or on an individual fire cell. Each fire
cell reports `resolvedFireAreaM2`, `resolvedFireDiameterMeters`, and
`plumeVirtualOriginMeters` so the effective inputs can be inspected.

Fuel mass flow is `Q / heatOfCombustionKJPerKg` [kg/s], and specified soot/CO
yields [kg/kg] multiply that flow. The implementation converts plume mass flow
to hot-layer volume with fixed reference density 1.2 kg/m³. It does not solve
thermal expansion or pressure. The source represents an unobstructed plume;
interacting plumes, oxygen-limited burning, changing fuel area and plume
impingement are not resolved. Area can therefore affect mixing and dilution
without changing the specified fuel-product mass or HRR.

## Natural flow, leakage and mechanical extraction

`minimumVentVelocityMps` is retained only as a deprecated compatibility key,
defaults to zero, and is ignored. No minimum flow is imposed.

* Natural opening flow uses `v = Cd sqrt(2 g H ΔT/Ta + wind²)` [m/s] and
  `q = A v` [m³/s]. `H` is effective stack head [m], temperatures in the ratio
  are Kelvin, and the default wind is 0 m/s. Only an opening's intersection
  with the upper layer exhausts smoke. An explicit `naturalVentAreaM2` instead
  means effective smoke-exposed area; `naturalVentHeightMeters` sets head.
  `naturalVentilationEnabled` can disable this closure. This is an exhaust-only
  Boussinesq approximation with implicit clean replacement air, not a solved
  two-way vent or neutral-plane calculation. Nonzero wind is an explicit
  effective driving-speed assumption, not a directional pressure solution.
* `leakageRatePerSec` [1/s] removes a well-mixed fraction. A cell can add a local
  `leakageRatePerSec`; legacy cell `ventilation` is its fallback alias, not a
  second removal mechanism.
* `mechanicalVentilationM3Sec` [m³/s] on options or a floor is a floor total.
  It is allocated once across passable cells marked as opening/local exhaust
  locations, or uniformly across all passable cells when none are marked.
  A cell's `mechanicalVentilationM3Sec` is an additional explicit local extractor.
  Do not specify the same installed extractor as both floor and cell flow.

For one substep, rates add as `lambda = leakage + qNatural/V + qMechanical/V`
[1/s]. Removed fraction is `1 - exp(-lambda dt)`; the loss is attributed in
proportion to each mechanism's rate. Shrinking hot-layer volume changes local
exhaust residence time on later substeps. This well-mixed extraction closure
is an approximation. With zero buoyancy, wind, leakage and mechanical flow,
the natural outflow is exactly zero.

An outdoor stair cell already exhausts through its opening, so its stair link
does not apply that same outdoor loss again. Inter-floor transfer remains
separate. Outgoing requests for multiple stair links share one donor budget;
receiving cells share one capacity budget. A flux pass also tracks outgoing
volume separately from incoming volume so simultaneous inflow cannot authorize
more species to leave a donor than its starting inventory.

## Accounting and verification

`smokeConservationBalance(floors)` returns budgets for `soot` [kg], `co` [kg],
`volume` [m³], and `heat` [kJ]. Each includes initial inventory (also explicit
legacy smoke painting), generated amount, remaining amount, vented amount,
other loss, removal by editing, stair input/output, absolute error and relative
error. For all floors together stair input and output cancel. Soot deposition
is counted separately and removes no CO; heat loss is also explicit.

When a cell becomes full, species and heat remain in the cell. Unresolvable
additional entrained volume is counted as `suppressedEntrainmentVolumeM3`.
Hot-layer volume accounting is not conservation of total air mass. Capped
display extinction and visibility are never used to compute these budgets.
FDS overlays do not inject soot or CO into fallback inventories.

`tests/smoke-physics.test.mjs` verifies species/volume/heat budget relative
errors below 2e-12 for the specified fixture, pure zero-forcing ventilation,
separate losses, area effects, source geometry reporting, stair fan-out and
mirror symmetry. The symmetric room fixture's mirrored volume L1 error divided
by total volume is below 1e-4. The 5 s room fixture compares genuinely distinct
internal `dt=0.1` and `dt=0.05` s, requires volume-field relative L1 difference
below 5%, and conserved total soot/CO agreement within 2e-12 kg. The measured
volume difference for that fixture is about 3.3%; this is a regression tolerance
for first-order transport, not proof of accuracy for every scenario. Refine
timestep/cell size and compare against external FDS/CFAST data for each research
case. No absolute fire prediction or regulatory-compliance claim follows from
these tests.
