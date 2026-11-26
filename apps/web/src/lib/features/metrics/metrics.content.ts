import { serviceComparisonCopy } from '#lib/v1/serviceComparison.ts';
import { METRIC_SUMMARIES, type MetricKey } from '#lib/metrics.ts';
export { metricInfoFor } from '#lib/metrics.ts';
export type { MetricKey, SupplementalMetricKey } from '#lib/metrics.ts';

export type Confidence = 'proxy' | 'medium';

export type MetricClusterKey =
	| 'punctuality'
	| 'waitRegularity'
	| 'serviceDelivered'
	| 'crowding'
	| 'habits';

interface BilingualText {
	readonly en: string;
	readonly fr: string;
}
interface BilingualList {
	readonly en: readonly string[];
	readonly fr: readonly string[];
}

export interface MetricEntry {
	readonly key: MetricKey;
	readonly anchor: string;
	readonly cluster: MetricClusterKey;
	readonly family: number;
	readonly confidence: Confidence;
	readonly name: BilingualText;
	readonly sciName: string;
	readonly oneLiner: BilingualText;
	readonly definition: BilingualText;
	readonly math: BilingualText;
	readonly sql: string;
	/** The source's language when it isn't SQL. */
	readonly codeLanguage?: 'python';
	readonly notReally: BilingualText;
	readonly caveats: BilingualList;
}

export const METRIC_CLUSTER_ORDER: readonly MetricClusterKey[] = [
	'punctuality',
	'waitRegularity',
	'serviceDelivered',
	'crowding',
	'habits',
] as const;

export const METRICS: readonly MetricEntry[] = [
	{
		key: 'otp',
		...METRIC_SUMMARIES.otp,
		cluster: 'punctuality',
		family: 1,
		confidence: 'proxy',
		sciName: 'otp_pct',
		definition: {
			fr: 'Pour la sélection et la période affichées, ce pourcentage compte les relevés de retard issus des prévisions dans la bande à l’heure, de −60\u00a0s inclusivement à 300\u00a0s exclusivement. Chaque relevé à retard connu compte comme une observation; plusieurs relevés peuvent concerner le même trajet. Une valeur de 90\u00a0% signifie neuf observations sur dix dans cette bande. Les retards inconnus sont exclus du dénominateur. Cette mesure décrit les prévisions GTFS-RT, sans certifier les arrivées réelles ni compter les trajets ponctuels.',
			en: 'For the displayed selection and period, this percentage counts predicted-delay readings in the on-time band, from −60 s inclusive to 300 s exclusive. Each known-delay reading is one observation; multiple readings can describe the same trip. A value of 90% means nine observations in ten fall within that band. Unknown delays are excluded from the denominator. This measures GTFS-RT predictions, without certifying actual arrivals or counting punctual trips.',
		},
		math: {
			fr: 'Ponctualité = 100 × nombre de relevés dans [−60, 300) / nombre de relevés à retard connu. Les comptes des groupes sont additionnés avant la division. Le pourcentage entier est arrondi avec les demis s’éloignant de zéro\u00a0: 1 relevé sur 40 donne 3\u00a0%. Un numérateur inconnu ou un dénominateur nul donne une valeur indisponible.',
			en: 'On-time percentage = 100 × readings in [−60, 300) / readings with a known delay. Counts are pooled before division. The whole percentage rounds ties away from zero: 1 reading in 40 gives 3%. An unknown numerator or empty denominator gives an unavailable value.',
		},
		sql: `-- Route population; omit the route filter for a network receipt.
SELECT
    SUM(on_time_observation_count) AS on_time,
    SUM(delay_observation_count) AS known
FROM gold.route_delay_spine
WHERE provider_id = :provider_id AND route_id = :route_id
  AND provider_local_date BETWEEN :win_start AND :win_end;

# Equivalent publication rounding (gold.reader.rates.otp_pct):
from decimal import Decimal, ROUND_HALF_UP

def otp_pct(on_time, known):
    if on_time is None or not known or known <= 0:
        return None
    pct = 100.0 * float(on_time) / float(known)
    return int(Decimal(str(pct)).quantize(Decimal('1'), rounding=ROUND_HALF_UP))`,
		notReally: {
			fr: 'Ce pourcentage décrit des prévisions observées. Il ne compte ni les trajets arrivés à l’heure ni les usagers touchés. Une ligne peu desservie ou qui saute des arrêts peut tout de même afficher une forte ponctualité.',
			en: 'This percentage describes observed predictions. It counts neither trips that arrived on time nor affected riders. A route with infrequent service or skipped stops can still have a high on-time percentage.',
		},
		caveats: {
			fr: [
				'−60\u00a0s est inclus; 300\u00a0s est exclu. Exactement cinq minutes de retard est aussi exclu du numérateur des retards graves, qui exige plus de 300\u00a0s. Ces deux parts ne se complètent donc pas à 100\u00a0%.',
				'Pour les lignes et les rapports quotidiens, le dénominateur conserve tous les retards connus, même au-delà de ±3\u00a0600\u00a0s. Le retard moyen et les statistiques par arrêt utilisent une plage admissible différente.',
				'Les mises à jour répétées d’un trajet comptent séparément. Cette pondération par observations ne représente pas le nombre d’usagers.',
				'Une cellule sans retard connu n’ajoute aucune observation au total. Un dénominateur entièrement vide donne une valeur indisponible, jamais une ponctualité de zéro.',
				'Les périodes utilisent les dates locales du fournisseur. Les journées de 23 ou 25 heures peuvent changer le mélange d’observations; les seuils restent les mêmes.',
				'La couleur d’un véhicule sur la carte suit des bandes de retard distinctes. Elle ne remplace pas ce pourcentage calculé sur plusieurs observations.',
			],
			en: [
				'−60 s is included; 300 s is excluded. Exactly five minutes late is also excluded from the severe-delay numerator, which requires more than 300 s. These two shares therefore do not add up to 100%.',
				'For routes and daily reports, the denominator retains all known delays, including those beyond ±3,600 s. Average delay and stop statistics use a different accepted range.',
				'Repeated updates for one trip count separately. This observation weighting does not represent rider numbers.',
				'A cell without known delays adds no observations to the total. An entirely empty denominator gives an unavailable value, never an on-time percentage of zero.',
				'Periods use the provider’s local dates. Days of 23 or 25 hours can change the observation mix; the thresholds stay the same.',
				'A vehicle’s map color follows separate delay bands. It does not replace this percentage across multiple observations.',
			],
		},
	},
	{
		key: 'avgDelay',
		...METRIC_SUMMARIES.avgDelay,
		cluster: 'punctuality',
		family: 2,
		confidence: 'proxy',
		sciName: 'avg_delay_min',
		definition: {
			fr: 'La somme des écarts utilisables issus des prévisions divisée par le nombre d’observations. Les valeurs manquantes et celles qui dépassent une heure en avance ou en retard sont exclues. Chaque observation compte, y compris les mises à jour répétées d’un même trajet.',
			en: 'The sum of usable predicted deviations divided by their observation count. Missing values and deviations more than one hour early or late are excluded. Each observation counts, including repeated updates for the same trip.',
		},
		math: {
			fr: 'Moyenne = somme des retards connus dans [−3\u00a0600, 3\u00a0600]\u00a0s / nombre de ces observations. Les sommes et les comptes se cumulent sans arrondir les moyennes intermédiaires. Le résultat est converti en minutes, puis arrondi à une décimale, les demis s’éloignant de zéro. Aucun dénominateur utilisable, ou une heure contributrice inconnue dans le résumé quotidien, donne une valeur indisponible.',
			en: 'Mean = sum of known delays within [−3,600, 3,600] s / count of those observations. Sums and counts are pooled without rounding intermediate means. The result is converted to minutes, then rounded to one decimal place with ties away from zero. An empty usable denominator, or an unknown contributing hour in the daily summary, gives an unavailable value.',
		},
		sql: `SELECT
    rd.provider_id,
    rd.route_id,
    (rd.period_start_utc AT TIME ZONE dp.timezone)::date AS local_date,
    CASE WHEN BOOL_AND(
        rd.usable_delay_observation_count IS NOT NULL
        AND (rd.usable_delay_observation_count = 0
             OR rd.usable_delay_sum_seconds IS NOT NULL)
    ) THEN SUM(rd.usable_delay_sum_seconds)::numeric
           / NULLIF(SUM(rd.usable_delay_observation_count), 0)
    END AS avg_delay_seconds
FROM gold.route_delay_hourly AS rd
JOIN gold.dim_provider AS dp ON dp.provider_id = rd.provider_id
GROUP BY rd.provider_id, rd.route_id, local_date;`,
		notReally: {
			fr: 'Cette moyenne décrit les prévisions observées. Elle ne mesure pas les arrivées réelles ni la durée d’un trajet. La médiane décrit le milieu de la distribution des observations; un trajet signalé plus souvent pèse davantage dans les deux mesures.',
			en: 'This mean describes observed predictions. It does not measure actual arrivals or journey duration. The median describes the middle of the observation distribution; a trip reported more often carries more weight in both measures.',
		},
		caveats: {
			fr: [
				'La moyenne est sensible aux valeurs extrêmes qui restent dans la plage admissible.',
				'Les résumés quotidiens suivent la date locale de collecte et peuvent inclure une journée en cours. Les périodes plus longues utilisent les dates de leurs résumés conservés; leurs horloges diffèrent encore près de minuit.',
				'Une ancienne moyenne arrondie ne suffit pas à retrouver une somme exacte. Si une heure contributrice ne peut pas être reconstituée, la moyenne du jour reste indisponible.',
				'Le classement de la pire ligne est indisponible si la comparaison quotidienne contient une ligne admissible dont la moyenne est inconnue.',
				'Une valeur indisponible est distincte de zéro. L’absence de prévision ne prouve pas le respect de l’horaire.',
				'La ponctualité utilise son propre dénominateur de retards connus, y compris ceux exclus de cette moyenne.',
			],
			en: [
				'The mean is sensitive to extreme values that remain within the accepted range.',
				'Daily summaries use the local collection date and can include the current partial day. Longer periods use retained summary dates; their reporting clocks still differ near midnight.',
				'An old rounded mean cannot recover an exact sum. If a contributing hour cannot be reconstructed, the daily mean remains unavailable.',
				'The worst-route ranking is unavailable when the daily comparison includes an eligible route with an unknown mean.',
				'Unavailable differs from zero. A missing prediction does not prove on-time service.',
				'On-time percentage uses its own known-delay denominator, including delays excluded from this mean.',
			],
		},
	},
	{
		key: 'p50p90',
		...METRIC_SUMMARIES.p50p90,
		cluster: 'punctuality',
		family: 2,
		confidence: 'proxy',
		sciName: 'p50_min · p90_min',
		definition: {
			fr: 'Les valeurs quotidiennes sont des centiles continus des prévisions au retard connu et compris entre −3\u00a0600 et +3\u00a0600\u00a0s, pour une même date locale de collecte. Chaque observation compte; un même trajet peut contribuer plusieurs fois. Le calcul interpole entre les valeurs triées. Avec des égalités ou de petits échantillons, exactement 10\u00a0% des observations ne sont pas forcément supérieures au 90e centile. Les estimations sur des périodes plus longues utilisent les histogrammes regroupés lorsqu’ils sont disponibles; une moyenne de centiles quotidiens ne reconstitue pas le centile de la période.',
			en: 'Daily values are continuous percentiles of known predicted delays between −3,600 and +3,600 s on one provider-local collection date. Each observation counts; one trip can contribute repeatedly. The calculation interpolates between sorted values. With ties or small samples, exactly 10% of observations need not exceed p90. Longer-period estimates use pooled histograms where available; averaging daily percentiles cannot reconstruct a period percentile.',
		},
		math: {
			fr: 'Pour n observations triées d[0]…d[n−1] et p = 0,5 ou 0,9\u00a0: h = (n−1)p, i = floor(h), f = h−i; Qp = d[i] + f·(d[min(i+1, n−1)] − d[i]). Le résumé quotidien stocke Qp à 0,01\u00a0s; l’affichage convertit en minutes. Les centiles d’histogramme interpolent dans des classes et restent des estimations. Aucun échantillon admissible signifie une valeur absente.',
			en: 'For n sorted observations d[0]…d[n−1] and p = 0.5 or 0.9: h = (n−1)p, i = floor(h), f = h−i; Qp = d[i] + f·(d[min(i+1, n−1)] − d[i]). The daily summary stores Qp to 0.01 s; display converts to minutes. Histogram percentiles interpolate within bins and remain estimates. No eligible sample means an unavailable value.',
		},
		sql: `-- p50/p90 (DAY grain only), gold.route_delay_percentile_daily, computed per closed local day over raw facts:
INSERT INTO gold.route_delay_percentile_daily (...)
SELECT f.provider_id, :local_date, f.route_id,
       COUNT(*)::integer,
       ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY f.delay_seconds)::numeric, 2),
       ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY f.delay_seconds)::numeric, 2),
       :built_at_utc
FROM gold.fact_trip_delay_snapshot AS f
INNER JOIN gold.dim_provider AS dp ON dp.provider_id = f.provider_id
WHERE f.provider_id = :provider_id
  AND f.route_id IS NOT NULL
  AND f.delay_seconds IS NOT NULL
  AND ABS(f.delay_seconds) <= 3600            -- GHOST_DELAY_ABS_SECONDS
  AND timezone(dp.timezone, f.captured_at_utc)::date = :local_date
GROUP BY f.provider_id, f.route_id;`,
		notReally: {
			fr: 'Ces centiles décrivent les prévisions collectées. Ils ne mesurent pas ce qu’un trajet ou un usager a vécu, ne prédisent pas un trajet particulier et ne constituent pas une garantie de retard maximal. Le 90e centile et la médiane doivent appartenir à la même population et à la même période pour être comparés.',
			en: 'These quantiles describe collected predictions. They do not measure an individual trip or rider experience, predict a particular journey, or guarantee a maximum delay. A 90th percentile and median must belong to the same population and period to be compared.',
		},
		caveats: {
			fr: [
				'Distinguer les centiles quotidiens sur les observations, les estimations d’histogramme sur une période et les centiles en direct des retards moyens par trajet.',
				'Les observations répétées ne sont pas des trajets ni des usagers indépendants. La fréquence des relevés influence leur poids.',
				'Le filtre |retard| ≤ 3\u00a0600\u00a0s définit la population; il ne certifie pas la justesse des prévisions restantes.',
				'Une valeur absente n’est pas zéro. La date, la couverture et la provenance indiquent le contexte; la politique de conservation est configurable.',
			],
			en: [
				'Distinguish daily observation percentiles, period histogram estimates, and live percentiles of current trip-average delays.',
				'Repeated reports are not independent trips or riders. Reporting frequency affects their weight.',
				'The |delay| ≤ 3,600 s filter defines the population; it does not certify the accuracy of the remaining predictions.',
				'Unavailable is not zero. Date, coverage and provenance supply context; retention policy is configurable.',
			],
		},
	},
	{
		key: 'severe',
		...METRIC_SUMMARIES.severe,
		cluster: 'punctuality',
		family: 3,
		confidence: 'proxy',
		sciName: 'severe_pct',
		definition: {
			fr: 'Un retard grave dépasse 300\u00a0s sans dépasser 3\u00a0600\u00a0s. Pour une ligne ou un rapport quotidien, le dénominateur comprend tous les relevés à retard connu, même ceux hors de la plage ±3\u00a0600\u00a0s. Pour les statistiques par arrêt, seuls les relevés dans cette plage comptent. Les classements des points chauds et des récidivistes utilisent aussi cette plage. Ces pourcentages décrivent des prévisions, pas des arrivées mesurées ni une part des usagers.',
			en: 'A severe delay exceeds 300 s and is no more than 3,600 s. For a route or daily report, the denominator includes every known-delay reading, including those outside ±3,600 s. Stop statistics count only readings within that range. Hotspot and repeat-offender rankings also use that range. These percentages describe predictions, not measured arrivals or a share of riders.',
		},
		math: {
			fr: 'Part des retards graves = 100 × nombre de relevés dans (300, 3\u00a0600] / nombre de relevés admissibles pour la vue. Les comptes sont additionnés avant la division; le résultat est arrondi à une décimale avec les demis s’éloignant de zéro. Exemple\u00a0: avec des retards de 600 et 7\u00a0200\u00a0s, la part d’une ligne est 50\u00a0%, mais celle d’un arrêt est 100\u00a0%, car son dénominateur exclut le second relevé. Un dénominateur vide donne une valeur indisponible.',
			en: 'Severe-delay share = 100 × readings in (300, 3,600] / readings eligible for the view. Counts are pooled before division; the result rounds to one decimal place with ties away from zero. For example, delays of 600 and 7,200 s give a route share of 50%, but a stop share of 100%, because its denominator excludes the second reading. An empty denominator gives an unavailable value.',
		},
		sql: `-- Route population: outliers remain in the denominator.
COUNT(delay_seconds) AS known,
COUNT(*) FILTER (
    WHERE delay_seconds > 300 AND delay_seconds <= 3600
) AS severe

-- Stop population: apply this filter before counting or summing.
WHERE delay_seconds IS NOT NULL AND ABS(delay_seconds) <= 3600

# Equivalent publication rounding (gold.reader.rates.severe_pct):
from decimal import Decimal, ROUND_HALF_UP

def severe_pct(observations, severe):
    if not observations or observations <= 0:
        return None
    pct = 100.0 * float(severe or 0) / float(observations)
    return float(Decimal(str(pct)).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP))`,
		notReally: {
			fr: 'Un taux de 8\u00a0% ne signifie pas que 8\u00a0% des trajets ou des véhicules étaient gravement en retard. Un même trajet peut produire plusieurs relevés. Cette mesure ne compte pas les usagers touchés et ne vérifie pas les arrivées physiques.',
			en: 'An 8% share does not mean 8% of trips or vehicles were severely late. One trip can produce many readings. This measure does not count affected riders or verify physical arrivals.',
		},
		caveats: {
			fr: [
				'300\u00a0s est exclu du numérateur; 3\u00a0600\u00a0s est inclus. Au-delà d’une heure, un relevé reste dans le dénominateur d’une ligne mais ne compte jamais comme retard grave.',
				'Les retards inconnus sont exclus. Pour les arrêts et les classements, les relevés hors de ±3\u00a0600\u00a0s sont aussi exclus du dénominateur; comparer ces populations demande donc de la prudence.',
				'Les comptes bruts se composent entre périodes; les pourcentages quotidiens ne sont pas moyennés.',
				'Zéro signifie aucun retard grave parmi les observations admissibles. Une valeur indisponible signifie que leur dénominateur est vide.',
				'La fréquence de signalement influence le résultat\u00a0: plusieurs prévisions d’un même trajet comptent séparément.',
			],
			en: [
				'300 s is excluded from the numerator; 3,600 s is included. Beyond one hour, a reading remains in a route’s denominator but never counts as severe.',
				'Unknown delays are excluded. Stops and rankings also exclude readings outside ±3,600 s from their denominator, so comparisons across these populations require care.',
				'Raw counts combine across periods; daily percentages are not averaged.',
				'Zero means no severe delays among the eligible observations. An unavailable value means their denominator is empty.',
				'Reporting frequency influences the result: multiple predictions for one trip count separately.',
			],
		},
	},
	{
		key: 'weakStops',
		...METRIC_SUMMARIES.weakStops,
		cluster: 'punctuality',
		family: 11,
		confidence: 'proxy',
		sciName: 'weak_stops',
		definition: {
			fr: 'Dans la vue par période, le classement utilise la borne inférieure de Wilson de la part sans retard grave\u00a0: une borne plus basse place l’arrêt plus haut. Les barres montrent la part des retards graves, pas le score de classement. Seuls les arrêts ayant au moins 30 observations admissibles sont retenus, avec au plus 15 arrêts par période. Si cette vue est indisponible, le résumé classe les arrêts par retard moyen sur les 30 dates locales se terminant au dernier jour clos disponible. Les deux calculs excluent les retards inconnus ou hors de [−3\u00a0600, 3\u00a0600]\u00a0s.',
			en: 'In the period view, ranking uses the lower Wilson bound of the non-severe share: a lower bound places the stop higher. Bars show severe-delay share, not the ranking score. Only stops with at least 30 eligible observations qualify, with at most 15 stops per period. If this view is unavailable, the summary ranks stops by mean delay over the 30 local dates ending on the latest available closed day. Both calculations exclude unknown delays and values outside [−3,600, 3,600] s.',
		},
		math: {
			fr: 'Par période, n est le nombre de relevés admissibles et k = n − nombre de retards graves. La borne inférieure de Wilson pour k/n, avec z = 1,96, est classée en ordre croissant; les égalités sont départagées par retard moyen décroissant, puis identifiant d’arrêt. Le résumé utilise plutôt la moyenne non arrondie, somme des retards / n, puis l’identifiant. Les minutes publiées sont arrondies à une décimale avec les demis s’éloignant de zéro. Les comptes sont regroupés avant tout ratio.',
			en: 'For each period, n is the eligible reading count and k = n − severe-delay count. The lower Wilson bound for k/n, with z = 1.96, sorts ascending; ties break by mean delay descending, then stop ID. The summary instead uses the unrounded mean, sum of delays / n, then stop ID. Published minutes round to one decimal place with ties away from zero. Counts are pooled before any ratio.',
		},
		sql: `-- Summary window: latest closed stop-delay date minus 29 days through that date.
SELECT stop_id,
       SUM(observation_count) AS observations,
       SUM(sum_delay_seconds) AS total_delay_seconds,
       SUM(severe_delay_count) AS severe
FROM gold.stop_delay_spine
WHERE provider_id = :provider_id AND route_id = :route_id
  AND provider_local_date BETWEEN :win_start AND :win_end
GROUP BY stop_id;

# Period view: require observations >= 30.
# Sort by (wilson_lo(observations - severe, observations), -avg_delay_min, stop_id).
# Retain at most 15; bars show 100 * severe / observations.
# Wilson bounds use gold.reader.rates.wilson_lo/hi with z=1.96.

# Summary fallback: ignore empty groups.
mean_seconds = total_delay_seconds / observations
# Sort by (-mean_seconds, stop_id); the default publication cap is 100.
# Published minutes use gold.reader.rates.avg_delay_min (ties away from zero).`,
		notReally: {
			fr: 'Ce classement ne prédit pas votre prochain trajet et ne mesure pas les arrivées réelles. Une borne de Wilson basse peut aussi traduire un petit échantillon; elle ne prouve pas qu’un arrêt est systématiquement le pire.',
			en: 'This ranking does not predict your next trip or measure actual arrivals. A low Wilson bound can also reflect a small sample; it does not prove a stop is consistently the worst.',
		},
		caveats: {
			fr: [
				'La moyenne est pondérée par observations, pas par trajets ou usagers. Un trajet signalé plus souvent pèse davantage.',
				'La période de 30 dates peut contenir des jours sans données. Elle se termine au dernier jour disponible, qui peut être ancien si le flux est interrompu.',
				'Les retards hors de ±3\u00a0600\u00a0s sont exclus, même lorsqu’ils correspondent à un incident réel.',
				'Un arrêt sans observation admissible est absent du classement. Une liste courte n’est pas complétée artificiellement.',
				'Les prévisions répétées ne sont pas des essais indépendants. Les bornes de Wilson décrivent le calcul utilisé; leur couverture réelle de 95\u00a0% n’a pas été validée.',
			],
			en: [
				'The mean is weighted by observations, not trips or riders. A trip reported more often carries more weight.',
				'The 30-date period can contain days without data. It ends on the latest available day, which may be old if reporting has stopped.',
				'Delays outside ±3,600 s are excluded, even when they reflect a real incident.',
				'A stop without eligible observations is absent from the ranking. Short lists are not padded.',
				'Repeated predictions are not independent trials. Wilson bounds describe the calculation used; their real-world 95% coverage has not been validated.',
			],
		},
	},
	{
		key: 'regularityCov',
		...METRIC_SUMMARIES.regularityCov,
		cluster: 'waitRegularity',
		family: 4,
		confidence: 'proxy',
		sciName: 'headway_cov · bunched_pct',
		definition: {
			fr: 'Ces mesures décrivent les premières collectes admissibles de trajets, pas des arrivées mesurées à un arrêt. Le CV divise l’écart-type des intervalles par leur moyenne. La part d’apparitions rapprochées mesure les écarts inférieurs à la moitié de la médiane. Les vues par jour, semaine et mois regroupent les statistiques quotidiennes conservées; elles couvrent la direction comptant le plus de trajets de semaine dans chaque période.',
			en: 'These measures describe the first eligible feed captures of trips, not measured stop arrivals. CoV divides the sample standard deviation of gaps by their mean. The closely spaced share measures gaps below half the median. Day, week and month views pool retained daily statistics; they cover the direction with the most observed weekday trips in each period.',
		},
		math: {
			fr: 'Pour les périodes de 1, 7 et 30 jours\u00a0: n = nombre d’écarts, S = somme des écarts en minutes, Q = somme de leurs carrés. CV = sqrt(max((Q − S²/n)/(n−1), 0)) / (S/n), arrondi à 4 décimales; valeur indisponible si n < 2 ou S ≤ 0. Cette formule utilise les moments conservés, pas l’histogramme. La part rapprochée est estimée dans l’histogramme regroupé sous T = 0,5 × médiane publiée, avec répartition uniforme dans la classe coupée par T, puis arrondie à une décimale.',
			en: 'For the 1-, 7- and 30-day periods: n is the gap count, S the sum of gap minutes, and Q the sum of squared gap minutes. CoV = sqrt(max((Q − S²/n)/(n−1), 0)) / (S/n), rounded to 4 decimals; unavailable if n < 2 or S ≤ 0. This uses the retained moments, not the histogram. The closely spaced share estimates pooled histogram mass below T = 0.5 × published median, assuming uniform values inside the bin crossed by T, then rounds to one decimal place.',
		},
		codeLanguage: 'python',
		sql: `# Pool daily count and moments over the selected direction, shift and window.
mean = sum_gap / n if n else None
variance = max((sum_gap_sq - sum_gap**2 / n) / (n - 1), 0) if n >= 2 else None
cov = round_half_away(math.sqrt(variance) / mean, 4) if variance is not None and mean > 0 else None

# Bunching is re-estimated from pooled bins, never summed from daily bunched counts.
bunched = bunched_pct(pooled_gap_histogram, gap_edges, published_median)
bunched_pct_value = round_half_away(bunched, 1) if bunched is not None else None`,
		notReally: {
			fr: 'Une part rapprochée de 18\u00a0% ne signifie pas que 18\u00a0% des véhicules arrivent collés à votre arrêt. Les collectes manquantes et les interruptions du flux peuvent modifier les écarts. Ni le CV ni cette part ne mesure la ponctualité, les usagers touchés ou les trajets annulés.',
			en: 'A closely spaced share of 18% does not mean 18% of vehicles arrive together at your stop. Missed captures and feed interruptions can change the gaps. Neither CoV nor this share measures on-time performance, affected riders or cancelled trips.',
		},
		caveats: {
			fr: [
				'Les écarts proviennent de trajets avec retard issu des prévisions connu dans [−3\u00a0600, 3\u00a0600]\u00a0s; seuls les écarts strictement dans (0, 240) minutes sont admissibles, dans une même direction, journée de service et période horaire.',
				'Les périodes se terminent au dernier jour clos disponible de la série et regroupent les données admissibles de semaine. La direction la plus représentée peut changer entre périodes.',
				'Le CV est recomposé à partir des moments; la médiane et la part rapprochée sont des estimations issues des histogrammes. Le même nombre d’écarts sert de dénominateur.',
				'Le résumé sans période reste une série distincte sur la durée de conservation configurée des relevés bruts, de 14 jours par défaut\u00a0: médiane continue, écart-type d’échantillon et décompte direct des écarts inférieurs à la demi-médiane.',
				'CV = 0 décrit des écarts constants. CV indisponible signifie moins de deux écarts ou une moyenne non positive; la part rapprochée est indisponible sans écarts.',
			],
			en: [
				'Gaps come from trips with known predicted delays within [−3,600, 3,600] s; only gaps strictly within (0, 240) minutes qualify, within one direction, service day and shift.',
				'Periods end on the series’ newest available closed day and pool eligible weekday data. The busiest observed direction can change between periods.',
				'CoV is reconstructed from moments; the median and closely spaced share are histogram estimates. The same gap count supplies their denominator.',
				'The non-windowed summary uses the configured raw-fact retention period, 14 days by default, with a continuous median, sample standard deviation and direct count of gaps below half the median.',
				'CoV = 0 describes constant gaps. Unavailable CoV means fewer than two gaps or a nonpositive mean; the closely spaced share is unavailable without gaps.',
			],
		},
	},
	{
		key: 'headway',
		...METRIC_SUMMARIES.headway,
		cluster: 'waitRegularity',
		family: 4,
		confidence: 'proxy',
		sciName: 'observed_min · scheduled_min',
		definition: {
			fr: 'On retient la première collecte admissible de chaque trajet et journée de service\u00a0: retard issu des prévisions connu et compris entre −3\u00a0600 et 3\u00a0600\u00a0s. Les écarts entre apparitions successives restent dans la même ligne, direction, journée de service et période horaire; seuls les écarts strictement positifs et inférieurs à 240 minutes sont retenus. Les vues par jour, semaine et mois estiment une médiane à partir des histogrammes quotidiens regroupés. Le repère prévu vient du GTFS actuel, sur une journée de semaine représentative.',
			en: 'Each trip and service day contributes its first eligible capture: a known predicted delay within −3,600 to 3,600 s. Gaps between successive appearances stay within the same route, direction, service day and shift; only gaps strictly above zero and below 240 minutes remain. The day, week and month views estimate a median from pooled daily histograms. The scheduled reference comes from the current GTFS timetable on a representative weekday.',
		},
		math: {
			fr: 'Vue par période\u00a0: la médiane observée est estimée par interpolation du cumul des histogrammes d’écarts, arrondie à une décimale. Les périodes de 1, 7 et 30 jours se terminent au dernier jour clos de cette série et ne contiennent que les écarts admissibles de semaine. La direction retenue maximise le nombre de trajets observés dans chaque période. Le résumé sans période utilise la médiane continue sur la durée de conservation configurée des relevés bruts, de 14 jours par défaut. Le repère prévu est la médiane des écarts entre minutes de départ distinctes au premier arrêt, par période, dans la direction avec le plus de départs du GTFS actuel.',
			en: 'Period view: the observed median is estimated by interpolating the pooled gap-histogram cumulative distribution and rounding to one decimal place. The 1-, 7- and 30-day periods end on this series’ newest closed day and include only eligible weekday gaps. The selected direction has the most observed trips in each period. The non-windowed summary uses a continuous median over the configured raw-fact retention period, 14 days by default. The scheduled reference is the median gap between distinct first-stop departure minutes, per shift, in the direction with the most departures in the current timetable.',
		},
		codeLanguage: 'python',
		sql: `# Windowed observations: pool histogram counts, then estimate one median.
observed_min = round_half_away(cdf_percentile(pooled_gap_histogram, 0.5, gap_edges), 1)

# Current scheduled reference: distinct first-stop departure minutes within one shift.
minutes = sorted(set(departure_minutes))
gaps = [right - left for left, right in zip(minutes, minutes[1:])]
scheduled_min = round_half_away(statistics.median(gaps), 1) if gaps else None`,
		notReally: {
			fr: 'Un intervalle de 12 minutes ne promet pas un véhicule toutes les 12 minutes à votre arrêt. Les apparitions dans le flux ne sont pas des départs ou arrivées mesurés. Des trajets absents, des collectes manquantes ou une interruption du flux peuvent changer ces écarts. La différence entre les repères ne mesure pas l’attente excédentaire des usagers.',
			en: 'A 12-minute gap does not promise a vehicle every 12 minutes at your stop. Feed appearances are not measured departures or arrivals. Missing trips, missed captures or an interrupted feed can change these gaps. The difference between the two markers does not measure riders’ excess wait.',
		},
		caveats: {
			fr: [
				'Les histogrammes quotidiens sont conservés et regroupés; les médianes par période sont des estimations, pas des moyennes de médianes quotidiennes.',
				'Les périodes principale et précédente peuvent retenir des directions différentes. Les écarts affichés décrivent les échantillons et ne prouvent pas une évolution pour les mêmes trajets.',
				'Le repère prévu utilise l’horaire actuel et sa propre direction la plus fournie; il ne reconstitue pas l’horaire de chaque journée historique.',
				'Les vues par période regroupent les jours de collecte admissibles de semaine et excluent le service de fin de semaine. Les résumés par direction et fin de semaine, quand présents, sont des séries distinctes.',
				'Sans écarts admissibles, la médiane est indisponible. L’absence de données reste distincte d’un intervalle observé de zéro.',
			],
			en: [
				'Daily histograms are retained and pooled; period medians are estimates, not averages of daily medians.',
				'Current and previous periods can select different directions. Displayed changes describe the samples and do not establish a change for the same trips.',
				'The scheduled reference uses the current timetable and its own busiest direction; it does not reconstruct the timetable for each historical day.',
				'Period data pool eligible weekday collection dates and exclude weekend service. Direction and weekend summaries, when present, are separate series.',
				'Without eligible gaps, the median is unavailable. Missing data remains distinct from an observed zero-minute gap.',
			],
		},
	},
	{
		key: 'excessWait',
		...METRIC_SUMMARIES.excessWait,
		cluster: 'waitRegularity',
		family: 4,
		confidence: 'proxy',
		sciName: 'excess_wait_min',
		definition: {
			fr: 'Pour une période choisie, le modèle calcule l’attente moyenne = somme(écart²) / (2·somme(écart)), puis retranche la moitié de l’intervalle prévu. Il suppose des arrivées uniformes pendant les écarts observés; aucune fréquentation réelle n’est utilisée. La carte résumée donne le même poids à chaque période rapportée. Cette moyenne de périodes n’est pas une attente calculée sur tous les écarts de la journée. Les anciennes rangées sans moments conservent l’estimation max(0, médiane observée − médiane prévue).',
			en: 'For each shift in the selected period, the model calculates average wait = sum(gap²) / (2·sum(gap)), then subtracts half the scheduled gap. It assumes uniform rider arrivals over the observed gaps; actual rider counts are not used. The summary card gives each reporting shift equal weight. That shift mean is not a wait pooled from all gaps across the day. Older rows without gap moments retain the estimate max(0, observed median − scheduled median).',
		},
		math: {
			fr: 'Par période\u00a0: attente excédentaire = arrondi à une décimale de max(0, somme(écart²)/(2·somme(écart)) − prévu/2). Résumé\u00a0: somme des valeurs publiées disponibles / nombre de périodes qui en portent. Deux périodes d’excès 0 et 7,5 min donnent 3,75 min, affiché 3,8 min, quels que soient leurs nombres d’observations. L’absence de valeur reste inconnue.',
			en: 'Per shift: excess wait = round(max(0, sum(gap²)/(2·sum(gap)) − scheduled/2), 1). Summary: sum of available published values / number of reporting shifts. Shift values of 0 and 7.5 min average to 3.75 min, displayed as 3.8 min, regardless of observation counts. Missing values remain unknown.',
		},
		sql: `-- Windowed per-shift model, calculated during publication:
-- awt = sum_gap_sq_min / (2 * sum_gap_min)
-- excess = round(max(0.0, awt - scheduled / 2.0), 1)
-- Older scalar rows without moments: max(0.0, observed - scheduled)
-- scheduled = median gap of distinct first-stop departure minutes per shift`,
		notReally: {
			fr: 'Ce modèle utilise les premières apparitions de trajets dans le flux. Il ne mesure ni les arrivées aux arrêts ni l’attente réelle des usagers. Un zéro signifie seulement que l’estimation ne dépasse pas la référence choisie; il ne prouve pas que le service a été effectué.',
			en: 'This model uses first trip appearances in the feed. It does not measure stop arrivals or actual rider waits. Zero only means the estimate did not exceed the selected reference; it does not prove that scheduled service ran.',
		},
		caveats: {
			fr: [
				'Chaque période utilise la direction qui compte le plus de trajets observés. Cette direction et les trajets représentés peuvent changer entre les périodes.',
				'Les trajets jamais apparus n’ajoutent pas de longue attente au modèle. Le choix des premiers témoins, la fréquence des relevés et les bornes d’écart influencent l’échantillon.',
				'La moyenne résumée donne le même poids à chaque période disponible. Ni cette moyenne ni une pondération par le seul nombre d’écarts ne reconstituent une attente journalière groupée\u00a0: il faudrait les sommes d’écarts et de leurs carrés.',
				'Les rangées sans moments utilisent un excès d’intervalle médian, distinct du modèle d’attente. Valeur absente si l’intervalle prévu ou les données nécessaires manquent.',
			],
			en: [
				'Each period uses the direction with the most observed trips. That direction and the represented trips can change between periods.',
				'Trips that never appear do not add a long wait to the model. First-witness selection, reporting frequency and gap bounds affect the sample.',
				'The summary gives every available shift equal weight. Neither that average nor weighting by gap counts alone reconstructs a pooled daily wait: that requires gap sums and squared-gap sums.',
				'Rows without gap moments use median-gap excess, a different quantity from modeled wait. Missing schedule or required observations leave the value unknown.',
			],
		},
	},
	{
		key: 'cancellation',
		...METRIC_SUMMARIES.cancellation,
		cluster: 'serviceDelivered',
		family: 5,
		confidence: 'proxy',
		sciName: 'cancellation_rate_pct',
		definition: {
			fr: 'Des trajets que le flux temps réel a réellement rapportés pour une ligne un jour donné, la part que le flux a marqués annulés. Un «\u00a0jour-trajet\u00a0» regroupe les observations ayant le même identifiant de trajet et la même date de service; s’il est signalé annulé au moins une fois, il compte comme annulé. Ainsi, «\u00a03,2\u00a0%\u00a0» signifie que sur 100 trajets mentionnés par le flux ce jour-là, environ 3 ont été annulés. C’est la part des trajets rapportés annulés, et non la part de l’horaire publié complet, car les trajets jamais mentionnés ne sont pas dans le compte.',
			en: 'Of the trips the realtime feed actually reported for a route on a given day, the share that the feed flagged as cancelled. A “trip-day” groups observations with the same trip ID and service date; if the feed marked that run cancelled at any point that day, it counts as cancelled. So “3.2%” means: out of every 100 trips the feed told us about that day, about 3 were called off. It is the share of reported trips that were cancelled, not the share of the full published timetable, because trips the feed never mentions are not in the count at all.',
		},
		math: {
			fr: 'Par ligne et par jour local clos\u00a0: taux d’annulation = arrondi à 2 décimales de 100 × jours-trajets annulés / jours-trajets observés, où les jours-trajets observés comptent les paires distinctes (identifiant de trajet, date de service) et les annulés comptent ceux signalés annulés au moins une fois (relation d’horaire 3). La valeur reste absente (et jamais 0) lorsqu’aucun jour-trajet n’est observé. Le total réseau est recalculé depuis les sommes brutes, et non moyenné à partir des taux par ligne.',
			en: 'Per route and closed provider-local day: cancellation rate = round(100 × cancelled trip-days / observed trip-days, 2), where observed trip-days count distinct (trip ID, service date) pairs and cancelled ones count those ever marked cancelled (schedule relationship 3). Absent (never 0) when zero trip-days are observed. The network total re-derives from summed counts, not a mean of route rates.',
		},
		sql: `WITH trip_day AS (
    SELECT
        f.provider_id, f.route_id, f.trip_id,
        f.start_date AS service_date,
        MAX((COALESCE(f.trip_schedule_relationship, 0) = 3)::int) AS was_canceled
    FROM gold.fact_trip_delay_snapshot AS f
    INNER JOIN gold.dim_provider AS dp ON dp.provider_id = f.provider_id
    WHERE f.provider_id = :provider_id
      AND f.route_id IS NOT NULL
      AND f.trip_id IS NOT NULL
      AND f.start_date IS NOT NULL
      AND timezone(dp.timezone, f.captured_at_utc)::date = :local_date
    GROUP BY f.provider_id, f.route_id, f.trip_id, f.start_date
)
INSERT INTO gold.route_cancellation_daily (... total_trip_days, canceled_trip_days, cancellation_rate_pct ...)
SELECT
    provider_id, :local_date, route_id,
    COUNT(*)::integer,
    COUNT(*) FILTER (WHERE was_canceled = 1)::integer,
    ROUND(100.0 * COUNT(*) FILTER (WHERE was_canceled = 1) / NULLIF(COUNT(*), 0), 2),
    :built_at_utc
FROM trip_day
GROUP BY provider_id, route_id
ON CONFLICT (provider_id, provider_local_date, route_id) DO UPDATE SET ...`,
		notReally: {
			fr: 'Un usager pourrait lire ce chiffre comme le pourcentage de tous les trajets prévus de cette ligne qui ont été annulés. Ce n’est pas le cas. Le dénominateur comprend seulement les trajets mentionnés par le flux; les trajets discrètement abandonnés sans avis d’annulation lui sont invisibles, donc le vrai taux d’annulation de l’horaire peut être plus élevé. C’est une estimation tirée du flux, pas un chiffre certifié sur le service effectué.',
			en: 'A reader might take this as the percentage of all scheduled trips on this route that were cancelled. It is not that. The denominator is only the trips the realtime feed reported; trips silently dropped without a cancelled flag are invisible to it, so the true timetable cancellation rate can be higher. It is a feed-reported estimate, not a certified service-completeness figure.',
		},
		caveats: {
			fr: [
				`${serviceComparisonCopy.fr.label}\u00a0: ${serviceComparisonCopy.fr.explanation}`,
				'Estimation, non certifiée\u00a0: il s’agit de la part des trajets rapportés par le flux GTFS-RT marqués annulés (relation d’horaire 3), et non d’une statistique certifiée par la société de transport. Aucune réconciliation entre service prévu et effectué n’intervient ici.',
				'Dénominateur fondé sur les trajets rapportés, et non sur l’horaire\u00a0: le total compte uniquement les jours-trajets mentionnés par le flux. Un trajet discrètement abandonné n’est pas compté comme annulé, et le taux réel par rapport à l’horaire publié peut être plus élevé.',
				'Relation absente traitée comme non annulée\u00a0: le GTFS-RT omet la relation d’horaire pour les trajets ordinaires; ces relevés restent au dénominateur comme trajets non annulés.',
				'Jour-trajet unique\u00a0: un trajet observé plusieurs fois le même jour compte une seule fois; il est compté annulé s’il a été signalé annulé ne serait-ce qu’une fois (statut persistant, biais vers l’annulation).',
				'Absent ou 0\u00a0: le taux reste absent (jamais un 0\u00a0% inventé) lorsqu’aucun jour-trajet n’est observé. Une panne du flux affiche une absence de données, jamais 0\u00a0% annulé.',
				'Relevés sans ligne exclus\u00a0: les relevés sans identifiant de ligne sont filtrés à la source et n’entrent pas dans les totaux d’annulation.',
				'Signaux non utilisés\u00a0: les trajets ajoutés, le pourcentage d’occupation, le niveau de congestion et le retard natif du flux ne jouent aucun rôle.',
				'Taux réseau pondéré par les effectifs, et non une moyenne des taux par ligne\u00a0: le taux du réseau divise la somme des trajets annulés par la somme des trajets observés.',
			],
			en: [
				`${serviceComparisonCopy.en.label}: ${serviceComparisonCopy.en.explanation}`,
				'Estimate, not certified: this is the share of trips the GTFS-RT feed reported as cancelled (schedule relationship 3). It is not an agency-certified statistic, with no scheduled-vs-operated reconciliation.',
				'Denominator is reported trips, not the timetable: the total counts only trip-days the feed actually mentioned. A trip silently dropped from the feed is not counted as cancelled, so the published-schedule rate can be higher.',
				'Omitted relationship treated as not cancelled: GTFS-RT omits schedule relationship for ordinary trips, which remain in the denominator as non-cancelled.',
				'One count per trip-day: a trip seen in many polls counts once, and is counted cancelled if it was ever marked cancelled that day (sticky, biasing toward cancellation).',
				'Absent vs 0: the rate stays absent (never a fabricated 0%) when zero trip-days are observed. A feed outage surfaces as no data, not 0% cancelled.',
				'Unrouted records excluded: readings without a route ID are filtered out at the source and never reach the cancellation totals.',
				'Unused feed signals: added trips, occupancy percentage, congestion level and native delay play no role; only trip-level cancellation drives this measure.',
				'Network rate is count-weighted, not a mean of route rates: the network trend divides total cancelled trip-days by total observed trip-days.',
			],
		},
	},
	{
		key: 'skippedStop',
		...METRIC_SUMMARIES.skippedStop,
		cluster: 'serviceDelivered',
		family: 8,
		confidence: 'proxy',
		sciName: 'skipped_stop_rate_pct',
		definition: {
			fr: 'Pour une ligne un jour clos, c’est la part des prévisions d’arrêt diffusées par le flux en direct qui portaient l’indicateur «\u00a0arrêt non desservi\u00a0». Autrement dit\u00a0: parmi toutes les mises à jour d’arrêt à venir transmises ce jour-là, quel pourcentage annonçait que le véhicule ne s’arrêterait pas. Un chiffre plus élevé indique davantage d’avis d’arrêt non desservi. Mesuré par ligne et par jour local clos, accumulé à partir du 18 juin 2026 sans historique rétroactif.',
			en: 'For one route on one finished calendar day, this is the share of stop predictions the agency’s live feed sent out that were marked “this stop will be skipped.” Think of it as: out of all upcoming-stop updates the route’s vehicles broadcast that day, what percentage said they would not stop there. A higher number means riders saw more skipped-stop notices. Measured per route and closed local day, accumulating forward from 18 June 2026 with no backfilled history.',
		},
		math: {
			fr: 'Taux d’arrêts non desservis = arrondi à 2 décimales de 100 × mises à jour marquées non desservies / toutes les mises à jour d’arrêt observées, par ligne sur un jour local. Le numérateur compte les mises à jour marquées non desservies (relation d’horaire 1 au niveau de l’arrêt); le dénominateur comprend toutes les mises à jour observées, y compris celles sans relation explicite (traitées comme prévues). Valeur absente lorsqu’aucune mise à jour n’a été observée ce jour-là.',
			en: 'Skipped-stop rate = round(100 × skipped stop-time updates / all observed stop-time updates, 2), grouped by route over one provider-local day. The numerator counts stop-level skipped updates (schedule relationship 1); the denominator includes all observed stop-time updates, including omitted relationships treated as scheduled. Absent when the route had zero observed updates that day.',
		},
		sql: `-- gold/rollups.py UPSERT_ROUTE_SKIPPED_STOP_DAILY (essential aggregation):
SELECT
    f.provider_id,
    :local_date,
    f.route_id,
    SUM(f.stop_time_update_count)::bigint,
    SUM(f.skipped_stop_count)::bigint,
    ROUND(
        100.0 * SUM(f.skipped_stop_count) / NULLIF(SUM(f.stop_time_update_count), 0),
        2
    ),
    :built_at_utc
FROM gold.fact_trip_delay_snapshot AS f
INNER JOIN gold.dim_provider AS dp ON dp.provider_id = f.provider_id
WHERE f.provider_id = :provider_id
  AND f.route_id IS NOT NULL
  AND timezone(dp.timezone, f.captured_at_utc)::date = :local_date
GROUP BY f.provider_id, f.route_id

-- gold/marts.py fact ETL, where the carried counts originate:
count(*)::integer AS stop_time_update_count,
-- GTFS-RT StopTimeUpdate.ScheduleRelationship SKIPPED = 1 (stop-level,
-- distinct from the trip-level CANCELED = 3); NULL = SCHEDULED.
count(*) FILTER (WHERE stc.schedule_relationship = 1)::integer
    AS skipped_stop_count`,
		notReally: {
			fr: 'Un usager pourrait lire ce chiffre comme «\u00a0X\u00a0% des véhicules de cette ligne ont sauté un arrêt aujourd’hui\u00a0». Ce n’est pas le cas. C’est la part des messages de prévision d’arrêt en direct portant un indicateur «\u00a0arrêt non desservi\u00a0», déclaré par le flux plutôt qu’un passage sans arrêt vérifié sur le terrain, et compté sur des messages de mise à jour (un arrêt achalandé en génère beaucoup), non sur des usagers, des trajets ou des montées.',
			en: 'A reader might take this as “X% of this route’s vehicles skipped a stop today.” It is not that. It is the share of live stop-prediction messages carrying a skipped-stop indicator: a feed-declared notice rather than a verified pass-by, counted over update messages (busy stops generate many updates), not over riders, trips or boardings.',
		},
		caveats: {
			fr: [
				'Estimation, non vérifiée\u00a0: il s’agit de l’indicateur GTFS-RT d’arrêt non desservi (relation d’horaire 1 au niveau de l’arrêt), déclaré dans le flux plutôt qu’un passage sans arrêt vérifié sur le terrain.',
				'Le dénominateur comprend toutes les mises à jour d’arrêt observées, y compris celles sans relation d’horaire explicite (traitées comme prévues).',
				'Aucun historique rétroactif\u00a0: la série s’accumule vers l’avant seulement depuis le 18 juin 2026; les jours antérieurs sont simplement absents, jamais zéro.',
				'Valeur absente\u00a0: le taux reste absent (jamais 0\u00a0%) lorsqu’une ligne ne compte aucune mise à jour observée ce jour-là.',
				'Série figée\u00a0: un jour déjà clôturé et horodaté n’est jamais recalculé; le taux d’une journée passée reste tel qu’il a été publié.',
				'Date locale du fournisseur\u00a0: les jours de changement d’heure comptent 23\u00a0h ou 25\u00a0h mais forment une seule journée locale; les premiers jours partiels peuvent avoir des dénominateurs réduits.',
				'Distinct des annulations de trajet\u00a0: l’arrêt non desservi (niveau arrêt) est distinct du taux d’annulation (niveau trajet).',
				'Signaux non utilisés\u00a0: le pourcentage d’occupation, le niveau de congestion, le retard natif et les trajets ajoutés ne sont pas utilisés.',
			],
			en: [
				'Estimate, not verified: this reflects the agency’s GTFS-RT skipped-stop indicator (stop-level schedule relationship 1), a feed-declared notice rather than a verified pass-by.',
				'The denominator includes all observed stop-time updates, including those with an omitted relationship (treated as scheduled).',
				'No backfill: history accrues forward only from 18 June 2026; earlier days are simply absent, never zero.',
				'Missing data handling: the rate stays absent (never 0%) when a route had zero observed updates that day.',
				'Immutable once closed: a finished, stamped day is never recomputed, so a past day’s rate stays as published.',
				'Provider-local day: clock-change days have 23 or 25 hours in a single local date bucket, and partial launch days have smaller denominators.',
				'Distinct from trip cancellations: stop-level skipped notices are separate from trip-level cancellations.',
				'Unused feed signals: occupancy percentage, congestion level, native delay and added trips are not used.',
			],
		},
	},
	{
		key: 'serviceSpan',
		...METRIC_SUMMARIES.serviceSpan,
		cluster: 'serviceDelivered',
		family: 7,
		confidence: 'proxy',
		sciName: 'service_span_min · first/last_trip_delay_min',
		definition: {
			fr: 'Pour chaque identifiant de trajet du jour de service D, on conserve sa première collecte trouvée dans les jours de collecte D et D+1. Les extrémités sont la plus précoce et la plus tardive de ces premières collectes. Le compte indique les identifiants de trajet distincts présents dans cette période. Le retard du premier trajet vient de son premier relevé; celui du dernier trajet vient de son dernier relevé dans la période. Ce dernier relevé peut être postérieur à l’extrémité droite et n’est pas nécessairement une arrivée au terminus.',
			en: 'For each trip ID with GTFS service date D, we retain its earliest capture found on collection dates D and D+1. The endpoints are the earliest and latest of those first captures. The count is the number of distinct trip IDs present in that period. The first trip’s delay comes from its earliest report; the last trip’s delay comes from its latest report in the period. That latest report can be later than the right endpoint and need not be a terminal arrival.',
		},
		math: {
			fr: 'Regroupement\u00a0: fournisseur, ligne et date de service GTFS. Pour chaque trajet, t est l’instant de sa première collecte dans D/D+1. Extrémités\u00a0: min(t) et max(t). L’écart en minutes entières est round((max(t) − min(t)) / 60\u00a0s). Le graphique utilise l’écart exact des instants UTC; ses graduations +h indiquent le temps écoulé. Les dates, heures et décalages UTC affichés sont locaux au fournisseur. Les retards signés sont convertis en minutes arrondies à une décimale.',
			en: 'Group by provider, route and GTFS service date. For each trip, t is its earliest capture inside D/D+1. Endpoints are min(t) and max(t). Span in whole minutes is round((max(t) − min(t)) / 60 s). The chart uses the exact UTC elapsed interval; its +hour ticks show elapsed time. Displayed dates, clocks and UTC offsets use the provider timezone. Signed delays convert to minutes rounded to one decimal place.',
		},
		sql: `-- service_date = the just-completed GTFS service day = :local_date - 1; read a 2-day
-- INDEXED window {date_key(service_date), date_key(:local_date)} capture dates only; later reports are outside this window.
WITH trip_starts AS (
    SELECT f.provider_id, f.route_id, f.trip_id,
           MIN(f.captured_at_utc) AS trip_start_utc,
           (ARRAY_AGG(f.delay_seconds ORDER BY f.captured_at_utc ASC, f.entity_index ASC))[1]  AS first_obs_delay,
           (ARRAY_AGG(f.delay_seconds ORDER BY f.captured_at_utc DESC, f.entity_index DESC))[1] AS last_obs_delay
    FROM gold.fact_trip_delay_snapshot AS f
    WHERE f.provider_id = :provider_id AND f.route_id IS NOT NULL AND f.trip_id IS NOT NULL
      AND f.snapshot_date_key IN (
          to_char((CAST(:local_date AS date) - 1), 'YYYYMMDD')::integer, :date_key)
      AND f.start_date = (CAST(:local_date AS date) - 1)   -- bucket by GTFS service day, not capture day
    GROUP BY f.provider_id, f.route_id, f.trip_id
),
ranked AS (
    SELECT provider_id, route_id, trip_start_utc, first_obs_delay, last_obs_delay,
           ROW_NUMBER() OVER (PARTITION BY provider_id, route_id ORDER BY trip_start_utc ASC, first_obs_delay ASC) AS rn_first,
           ROW_NUMBER() OVER (PARTITION BY provider_id, route_id ORDER BY trip_start_utc DESC, first_obs_delay ASC) AS rn_last
    FROM trip_starts
)
SELECT provider_id, (CAST(:local_date AS date) - 1), route_id,
       MIN(trip_start_utc), MAX(trip_start_utc),
       ROUND(EXTRACT(EPOCH FROM (MAX(trip_start_utc) - MIN(trip_start_utc))) / 60.0)::integer,
       MAX(first_obs_delay) FILTER (WHERE rn_first = 1),   -- first trip: its first-obs delay
       MAX(last_obs_delay)  FILTER (WHERE rn_last  = 1),   -- last trip: its latest captured-report delay
       COUNT(*)::integer, :built_at_utc
FROM ranked
GROUP BY provider_id, route_id`,
		notReally: {
			fr: 'Ce n’est ni une plage horaire officielle, ni une mesure du temps passé en circulation, ni un plancher garanti des heures d’exploitation. Une absence de collectes n’établit pas une absence de service; des relevés tardifs peuvent décaler les extrémités. Les retards décrivent des prévisions reçues, pas des départs ou arrivées mesurés.',
			en: 'This is neither an official timetable, a measure of time spent operating, nor a guaranteed lower bound on operating hours. Missing captures do not establish missing service; delayed reports can shift the endpoints. Delay readings describe received predictions, not measured departures or arrivals.',
		},
		caveats: {
			fr: [
				'La période est limitée aux dates de collecte D et D+1 pour la date de service D. Des relevés plus tardifs ou sans date de service ne sont pas inclus; la couverture d’un trajet de nuit prolongé n’est pas garantie.',
				'Les deux extrémités sont des premières collectes de trajets différents ou du même trajet. L’extrémité droite n’est pas le dernier relevé reçu de la journée.',
				'Le dernier retard affiché vient du dernier relevé du dernier trajet identifié, à un instant potentiellement différent de l’extrémité droite; il ne certifie pas le retard à l’arrivée.',
				'Le compte porte sur des identifiants de trajet groupés, pas sur des trajets achevés ni des usagers. Un seul identifiant, ou plusieurs premières collectes simultanées, donne un écart nul.',
				'Une durée nulle est un point sur le graphique. Une durée positive conserve sa largeur proportionnelle, même si l’annotation arrondie vaut zéro minute. Des retards peuvent être indisponibles alors que les extrémités et le compte sont connus.',
				'Le calcul UTC préserve la durée lors des changements d’heure; les dates et décalages locaux distinguent les jours et les heures répétées. L’axe part de zéro et s’étend au-delà de 24 heures si nécessaire.',
			],
			en: [
				'The period is limited to collection dates D and D+1 for service date D. Later reports and reports without a service date are excluded; complete coverage of extended overnight trips is not guaranteed.',
				'Both endpoints are first captures of different trips or the same trip. The right endpoint is not the day’s latest received report.',
				'The final delay reading is the latest report of the last appearing trip, potentially after the right endpoint; it does not establish arrival delay.',
				'The count covers grouped trip IDs, not completed journeys or riders. One ID, or several simultaneous first captures, gives a zero span.',
				'Zero duration draws a point. Positive durations retain proportional width even if the rounded annotation says zero minutes. Delays can be unavailable while endpoints and counts remain known.',
				'UTC arithmetic preserves elapsed time through clock changes; local dates and offsets distinguish days and repeated hours. The axis starts at zero and extends beyond 24 hours when needed.',
			],
		},
	},

	{
		key: 'occupancy',
		...METRIC_SUMMARIES.occupancy,
		cluster: 'crowding',
		family: 6,
		confidence: 'proxy',
		sciName: 'occupancy_mix',
		definition: {
			fr: 'Le niveau de remplissage des véhicules, exprimé comme la part des relevés tombés dans chacun des cinq niveaux d’occupation\u00a0: vide, plusieurs places assises libres, peu de places assises libres, debout, plein. Ce calcul repose uniquement sur le niveau d’occupation diffusé en direct (une catégorie comme «\u00a0places debout seulement\u00a0»), et non sur un décompte d’usagers ou un pourcentage de remplissage. Ainsi, «\u00a0debout = 0,32\u00a0» signifie que 32\u00a0% des relevés comportant un niveau indiquaient debout, et non «\u00a032\u00a0% plein\u00a0» ni «\u00a032\u00a0% des usagers debout\u00a0». Les lignes très desservies produisent plus de relevés et pèsent donc davantage.',
			en: 'How full vehicles are, expressed as the share of vehicle reports that fell into each of five occupancy levels: empty, many seats free, few seats free, standing room only, and full. It is built only from the occupancy category vehicles broadcast over the live feed, not from a headcount or percentage-full number. So “standing = 0.32” means 32% of vehicle reports carrying an occupancy level said standing room only, not “32% full” and not “32% of riders standing.” Levels are counted per report, so busy routes contribute more readings.',
		},
		math: {
			fr: 'Pour chaque niveau b\u00a0: part = nombre de relevés au niveau b / nombre total de relevés portant un code d’occupation de 0 à 5. Regroupement\u00a0: vide = 0, plusieurs places = 1, peu de places = 2, debout = 3 et 4, plein = 5; les codes 6, 7, 8 et les valeurs absentes sont écartés. Les cinq parts totalisent environ 1,0. Sans aucun relevé portant un niveau, la répartition entière reste absente plutôt que toute à zéro.',
			en: 'For each level b: share = reports in level b / total reports carrying occupancy codes 0 through 5. Grouping: empty = 0, many seats = 1, few seats = 2, standing = 3 and 4, full = 5; codes 6, 7, 8 and missing values are excluded. The five shares sum to about 1.0. With zero level-bearing reports, the entire mix stays absent rather than all zeros.',
		},
		sql: `-- gold/rollups.py UPSERT_ROUTE_OCCUPANCY_BAND_DAILY (the defining daily reduction)
INSERT INTO gold.route_occupancy_band_daily (
    provider_id, provider_local_date, route_id,
    observation_count, empty_count, many_seats_count,
    few_seats_count, standing_count, full_count, built_at_utc
)
SELECT
    f.provider_id,
    :local_date,
    COALESCE(f.route_id, '__unrouted__'),
    COUNT(*) FILTER (WHERE f.occupancy_status IN (0, 1, 2, 3, 4, 5))::integer,  -- observation_count
    COUNT(*) FILTER (WHERE f.occupancy_status = 0)::integer,        -- empty
    COUNT(*) FILTER (WHERE f.occupancy_status = 1)::integer,        -- many_seats
    COUNT(*) FILTER (WHERE f.occupancy_status = 2)::integer,        -- few_seats
    COUNT(*) FILTER (WHERE f.occupancy_status IN (3, 4))::integer,  -- standing (CRUSHED folds in)
    COUNT(*) FILTER (WHERE f.occupancy_status = 5)::integer,        -- full
    :built_at_utc
FROM gold.fact_vehicle_snapshot AS f
INNER JOIN gold.dim_provider AS dp ON dp.provider_id = f.provider_id
WHERE f.provider_id = :provider_id
  AND timezone(dp.timezone, f.captured_at_utc)::date = :local_date
GROUP BY f.provider_id, COALESCE(f.route_id, '__unrouted__')
ON CONFLICT (provider_id, provider_local_date, route_id) DO UPDATE SET ... ;

-- shares + honest-None: historic.py _occupancy_mix_from_bands
counts = {band: int(row[band] or 0) for band in _OCCUPANCY_BANDS}
total = sum(counts.values())
if not total: return None        # honest-None, never an all-zero mix`,
		notReally: {
			fr: 'Ce n’est ni le pourcentage de remplissage d’un véhicule ni la fraction des usagers debout. Une part «\u00a0debout = 0,32\u00a0» signifie que 32\u00a0% des relevés de véhicules portant un niveau indiquaient «\u00a0places debout seulement\u00a0»\u00a0: une répartition de catégories pondérée par observations, et non un facteur de charge, un décompte d’usagers ou une statistique par trajet. Les heures où les véhicules circulent à vide la nuit peuvent dominer la part «\u00a0vide\u00a0» même sur une ligne bondée à l’heure de pointe.',
			en: 'It is neither how full a vehicle is in percent nor what fraction of riders were standing. A reading of standing = 0.32 means 32% of vehicle reports carrying an occupancy level were tagged standing room only: an observation-weighted category mix, not a load factor, headcount or per-rider statistic. Empty vehicle-hours at night can dominate the “empty” share even on a route that is packed at rush hour.',
		},
		caveats: {
			fr: [
				'Estimation, non un facteur de charge\u00a0: les niveaux sont des catégories GTFS-RT auto-déclarées sans pourcentage numérique de remplissage. Le pourcentage d’occupation, le niveau de congestion et le retard natif ne sont pas utilisés dans cette série.',
				'Dénominateur fondé sur les relevés portant un niveau, et non sur des véhicules, des trajets ou des usagers. Un véhicule qui transmet plus souvent pèse davantage.',
				'Les codes 3 (places debout seulement) et 4 (peu de places debout) sont regroupés en un seul niveau «\u00a0debout\u00a0».',
				'Les codes 6, 7 et 8 (embarquement refusé ou données absentes) ainsi que les relevés sans niveau sont exclus du numérateur et du dénominateur.',
				'Absence honnête\u00a0: sans aucun relevé portant un niveau, toute la répartition reste absente, jamais tout à zéro; l’interface affiche «\u00a0aucune donnée\u00a0» plutôt que 0\u00a0%.',
				'Jour local du fournisseur (changements d’heure pris en compte)\u00a0: les véhicules sans ligne attribuée sont mis à part, et les vues par ligne sur 30 jours retiennent uniquement les lignes identifiées.',
				'Couverture dépendante du flux\u00a0: le champ d’occupation est présent sur la quasi-totalité des relevés (environ 99,8\u00a0%), accumulé vers l’avant sans remplissage rétroactif au-delà de l’historique conservé.',
				'Direct et historique forment deux populations distinctes; les modes sans données en temps réel en sont structurellement absents.',
			],
			en: [
				'Estimate, not a load factor: levels are self-reported GTFS-RT categories with no numeric percent-full value. Occupancy percentage, congestion level and native delay are not used in this archived series.',
				'Denominator is level-bearing reports, not vehicles, trips or riders. A vehicle that reports more frequently carries more weight.',
				'Codes 3 (standing room only) and 4 (limited standing room) are combined into one “standing” band.',
				'Codes 6, 7 and 8 (not accepting passengers or no data) and missing values are excluded from both numerator and denominator.',
				'Honest absence: with zero level-bearing reports, the entire mix stays absent rather than all zeros, so screens show no data instead of 0%.',
				'Provider-local day (handling clock changes): vehicles without a route ID are kept separate, and 30-day route views filter to real routes.',
				'Feed-dependent coverage: the occupancy field is populated on roughly 99.8% of readings, accumulating forward with no backfill beyond retained history.',
				'Live and historical summaries describe different populations; modes without realtime feeds are structurally absent.',
			],
		},
	},
	{
		key: 'habits',
		...METRIC_SUMMARIES.habits,
		cluster: 'habits',
		family: 12,
		confidence: 'proxy',
		sciName: 'habits.matrix · repeat_problem_relative · severe_relative',
		definition: {
			fr: 'Chaque grille utilise un seul maximum pour ses 7 jours et 24 heures. Les scores de ligne combinent un compte de relevés de retard grave et un retard moyen positif. Les scores d’arrêt utilisent seulement le compte de relevés de retard grave. Les quatre couleurs divisent l’échelle relative en quatre tranches\u00a0: de 0 à moins de 0,25, de 0,25 à moins de 0,5, de 0,5 à moins de 0,75 et de 0,75 à 1. Le contour et le symbole ◆ marquent toute la dernière bande, y compris les valeurs inférieures au maximum. Une couleur pâle exprime un score relatif faible, sans prouver une faible fréquence de retard.',
			en: 'Each grid uses one maximum across its 7 days and 24 hours. Line scores combine a severe-delay reading count and a positive mean delay. Stop scores use only the severe-delay reading count. The four colors divide the relative scale into four bands: 0 to below 0.25, 0.25 to below 0.5, 0.5 to below 0.75, and 0.75 to 1. The outline and ◆ mark the entire highest band, including values below the maximum. A pale color expresses a low relative score without establishing a low delay frequency.',
		},
		math: {
			fr: 'Ligne\u00a0: score brut = min(arrondi à 4 décimales de (retards graves × 10 + max(retard moyen, 0) / 60), 9\u00a0999,9999). La moyenne regroupe les sommes de retard et les comptes des histogrammes admissibles, en excluant les relevés hors de ±3\u00a0600\u00a0s, puis s’arrondit à 2 décimales. Arrêt\u00a0: le score brut est la somme des relevés de retard grave, sans terme de moyenne ni facteur ×10. Pour chaque entité, score publié = arrondi à 4 décimales de (score brut / maximum sur toutes ses cellules fournies); si le maximum vaut zéro, les scores fournis restent zéro. Les valeurs indisponibles restent absentes. Les arrondis déplacent les demis à l’écart de zéro.',
			en: 'Line: raw score = min(round(severe count × 10 + max(mean delay seconds, 0) / 60, 4), 9,999.9999). The mean pools delay sums and eligible histogram counts, excluding readings outside ±3,600 s, then rounds to 2 decimals. Stop: raw score is the summed severe-delay reading count, with no mean term or ×10 factor. For each entity, published score = round(raw score / maximum across all supplied cells, 4); if the maximum is zero, supplied scores remain zero. Unavailable values stay absent. Rounding moves exact ties away from zero.',
		},
		sql: `-- ROUTE_HABIT_SPINE_SQL (gold/reader/projector.py), reconciled S14 2026-07-02: ONE reader-owned
-- formula (gold/reader/score.py REPEAT_PROBLEM_SCORE_EXPR) over gold.route_delay_spine. The old
-- gold.route_habit_score mart was DROPPED (migration 0076); the scalar 7x24 matrix runs this SQL
-- with an all-time window [1970-01-01 .. spine anchor], the by-grain matrices run the SAME SQL
-- with trailing day/week/month windows.
SELECT
    EXTRACT(ISODOW FROM provider_local_date)::integer AS day_of_week_iso,
    hour_of_day_local,
    SUM(delay_observation_count)::bigint AS known_obs,
    LEAST(
        ROUND(
            SUM(severe_delay_count)::numeric * 10
            + GREATEST(COALESCE(ROUND(
                SUM(sum_delay_seconds)::numeric
                / NULLIF(SUM((SELECT COALESCE(SUM(x), 0) FROM unnest(delay_histogram) AS x)), 0),
                2), 0), 0) / 60,
            4),
        9999.9999) AS repeat_problem_score   -- overflow guard, not a real magnitude
FROM gold.route_delay_spine
WHERE provider_id = :provider_id AND route_id = :route_id
  AND provider_local_date >= :win_start AND provider_local_date <= :win_end
GROUP BY 1, 2

-- Per-route [0,1] normalization at publish time (_helpers.py _build_habits_matrix):
-- observed = [v for v in cells if v is not None]; route_max = max(observed) or 0.0
-- cell = None if v is None else (round_half_away(v / route_max, 4) if route_max > 0 else 0.0)`,
		notReally: {
			fr: 'Un score de 1 ne prédit pas le retard d’un futur trajet et ne désigne pas le pire arrêt ou la pire ligne du réseau. Un score de 0 ne prouve pas que ce créneau est toujours calme; il indique seulement que le score fourni est nul. Une case indisponible ne prouve pas l’absence de service.',
			en: 'A score of 1 does not predict a future trip’s delay or identify the network’s worst stop or line. A score of 0 does not establish that a slot is consistently calm; it only means the supplied score is zero. An unavailable cell does not establish that no service ran.',
		},
		caveats: {
			fr: [
				'Les relevés sont des prévisions GTFS-RT, pas des arrivées mesurées ni des usagers comptés. Les relevés répétés d’un même trajet comptent séparément.',
				'Le volume de service et la fréquence des signalements peuvent augmenter les comptes et les scores. Sans dénominateur d’exposition, ce score n’est pas une fréquence ni une probabilité de retard.',
				'La normalisation est propre à chaque entité et au jeu de cellules fourni. Les mêmes couleurs de deux lignes ou arrêts ne donnent pas un classement de fiabilité.',
				'Le plafond de ligne à 9\u00a0999,9999 protège le stockage et peut égaliser des scores élevés. La bande ◆ commence à 0,75; elle ne désigne pas seulement les cellules exactement maximales.',
				'Zéro reste distinct d’une absence de valeur\u00a0: zéro est un score fourni nul, tandis qu’une case vide signifie qu’aucun score utilisable n’est disponible.',
				'Les changements d’heure peuvent modifier la durée couverte par une case locale. L’heure répétée d’automne regroupe les deux occurrences; une heure sautée n’existe pas le jour de la transition.',
				'La carte de ligne affichée utilise son historique disponible conservé; les variantes par période publiées utilisent la même formule. La carte d’arrêt utilise ses agrégats horaires disponibles, dont la couverture peut différer.',
			],
			en: [
				'Readings are GTFS-RT predictions, not measured arrivals or rider counts. Repeated readings of one trip count separately.',
				'Service volume and reporting frequency can increase counts and scores. Without an exposure denominator, this score is neither a delay frequency nor a delay probability.',
				'Normalization belongs to each entity and its supplied cells. Identical colors on different lines or stops do not rank their reliability.',
				'The line-score cap of 9,999.9999 protects storage and can make high scores equal. The ◆ band starts at 0.75; it does not identify only exact maximum cells.',
				'Zero stays distinct from absence: zero is a supplied zero score, whereas a blank cell means no usable score was available.',
				'Clock changes can alter a local cell’s elapsed coverage. The repeated autumn hour combines both occurrences; a skipped hour does not occur on its transition day.',
				'The displayed line grid uses its available retained history; published period variants use the same formula. The stop grid uses its available hourly aggregates, whose coverage can differ.',
			],
		},
	},
	{
		key: 'seasonality',
		...METRIC_SUMMARIES.seasonality,
		cluster: 'habits',
		family: 9,
		confidence: 'proxy',
		sciName: 'day_of_week.severe_pct',
		definition: {
			fr: 'Pour une ligne, cet indicateur regroupe chaque relevé d’écart à l’horaire par le jour de la semaine où il s’est produit (lundi à dimanche, heure locale) et montre, pour chaque jour, le retard moyen en minutes et la part des relevés gravement en retard (plus de 5 minutes). Cela répond à la question «\u00a0cette ligne est-elle régulièrement pire le vendredi que le mardi ?\u00a0» Le calcul porte sur tout l’historique conservé (jusqu’à 730 jours depuis le 2 juillet 2026), donc un véritable motif hebdomadaire de long terme plutôt que les seuls derniers jours.',
			en: 'For one route, this groups every schedule-deviation reading the feed gave us by the local day of the week it happened on (Monday through Sunday) and shows, for each weekday, average lateness in minutes and the share of readings that were severely late (more than 5 minutes behind). It answers whether a route is consistently worse on Fridays than on Tuesdays, calculated over the full retained history (up to 730 days, aligned since 2 July 2026) so it reflects a genuine long-run pattern rather than just the last few days.',
		},
		math: {
			fr: 'Par ligne et par jour de la semaine (lundi à dimanche), sur tout l’historique conservé\u00a0: on cumule les relevés à retard connu, les relevés graves (retard > 300\u00a0s et |retard| ≤ 3\u00a0600\u00a0s) et les relevés compris dans les 21 classes de l’histogramme (hors valeurs extrêmes). Le retard moyen en minutes divise la somme des retards par le nombre de relevés dans la plage admissible (moyenne groupée, non une moyenne de moyennes quotidiennes), arrondi à une décimale avec les demis s’éloignant de zéro. La part de retards graves divise les relevés graves par tous les relevés à retard connu, arrondie à une décimale; valeur absente lorsqu’il n’y a aucun relevé à retard connu.',
			en: 'Per route and local weekday (Monday to Sunday), over the full retained history: we pool readings with a known delay, severe readings (delay > 300 s and |delay| ≤ 3,600 s), and readings inside the 21 histogram bins (excluding extreme values). Average delay in minutes divides the pooled delay sum by the in-range reading count (a pooled mean, not a mean of daily means), rounded to one decimal place with ties away from zero. Severe-delay share divides severe readings by all known-delay readings, rounded to one decimal place; absent when there are no known-delay readings.',
		},
		sql: `-- route.spine.dow (gold/reader/projector.py PROJECT_TEMPLATE, dims = ISO weekday),
-- reconciled S14 2026-07-02: read at build time from gold.route_delay_spine over the
-- WHOLE accrual (NO window clause -> 730-day retention), replacing the dropped
-- gold.route_delay_day_of_week fold over gold.route_delay_hourly (migration 0064). The
-- count/share SUMs are byte-identical to the fold; avg_delay_min is the allowed pooled
-- rebaseline. avg_delay_min / severe_pct / observation_count are then derived in Python
-- from these SUMs (hist_and_avg + _severe_pct); the 21 delay_histogram bin SUMs are the
-- in-clamp (ghost-excluded) denominator, condensed here to unnest() for readability.
SELECT
    EXTRACT(ISODOW FROM provider_local_date)::integer AS day_of_week_iso,
    SUM(observation_count)::bigint         AS obs,
    SUM(delay_observation_count)::bigint   AS known_obs,       -- severe_pct denominator
    SUM(severe_delay_count)::bigint        AS severe,
    SUM(sum_delay_seconds)::bigint         AS sum_delay_sec,   -- pooled-avg numerator
    SUM((SELECT COALESCE(SUM(x), 0)
         FROM unnest(delay_histogram) AS x))::bigint AS in_clamp  -- 21-bin SUM = pooled-avg denominator
FROM gold.route_delay_spine
WHERE provider_id = :provider_id AND route_id = :route_id
GROUP BY 1
ORDER BY 1;`,
		notReally: {
			fr: 'Ce n’est ni une preuve qu’une ligne est toujours pire le vendredi ni une note certifiée par jour. C’est un retard moyen groupé et une part de retards graves par jour de semaine local sur tout l’historique conservé, tirés des prévisions, avec des échantillons inégaux d’un jour à l’autre. Une part élevée un jour donné peut reposer sur peu de relevés; elle se lit avec le nombre d’observations et le retard moyen ne remplace pas une médiane.',
			en: 'Not a statement that a route is always worse on Fridays or a certified day-of-week score. It is a pooled average delay and severe-late share per local weekday over the full retained history, from predicted deviations, with uneven samples across days. A high severe share on one weekday can rest on few readings; read it alongside the observation count, and do not treat the average as a median.',
		},
		caveats: {
			fr: [
				'Estimation, et non ponctualité certifiée\u00a0: bâti sur les écarts à l’horaire issus des prévisions GTFS-RT, et non sur un indicateur certifié par la société de transport.',
				'Dénominateur de la part de retards graves\u00a0: seuls les relevés à retard connu comptent au dénominateur (et non tous les relevés bruts). La part reste absente, jamais 0, lorsqu’aucun relevé à retard connu n’est disponible.',
				'Le retard moyen est une moyenne groupée des relevés dans la plage admissible (signée\u00a0: négatif pour une avance), et non une médiane. Aucun 50e ou 90e centile n’est calculé à ce niveau.',
				'Seuil grave\u00a0: retard supérieur à 5 minutes (300\u00a0s); les relevés au-delà d’une heure (3\u00a0600\u00a0s) sont traités comme valeurs aberrantes et exclus du numérateur et du dénominateur de la moyenne.',
				'Historique complet\u00a0: depuis le 2 juillet 2026, les profils par jour de semaine couvrent tout l’historique conservé (jusqu’à 730 jours) plutôt que la dizaine de jours précédente.',
				'Attribution au jour local\u00a0: le jour de semaine suit déjà la date locale du fournisseur, de sorte que les relevés après minuit et les jours de changement d’heure tombent dans le bon jour calendaire.',
				'Le nombre d’observations est publié, mais pas le nombre de trajets (une somme horaire gonflerait le nombre de trajets distincts).',
				'Les relevés sans identifiant de ligne et les signaux non utilisés du flux ne sont jamais affichés comme une vraie ligne.',
			],
			en: [
				'Estimate, not certified on-time performance: built from GTFS-RT predicted schedule deviations, not an agency-certified measure.',
				'Severe-share denominator: only readings with a known delay count in the denominator (not total raw observations). The share stays absent, never 0, when no known-delay readings exist.',
				'Average delay is a pooled mean of in-range readings (signed: negative means early), not a median. No median or 90th percentile is computed at this weekday level.',
				'Severe threshold is over 5 minutes (300 s); readings beyond one hour (3,600 s) are treated as outliers and excluded from both the severe numerator and the average-delay denominator.',
				'Full history: since 2 July 2026, weekday patterns span the full retained history (up to 730 days) rather than the earlier ~10-day window.',
				'Local-day attribution: weekday already follows the provider’s local calendar date, so post-midnight and clock-change readings land on the right day.',
				'Observation count is published, while trip count is not (summing hourly distinct trips would overcount distinct trips).',
				'Readings without a route ID and unused feed signals are never surfaced as a real route.',
			],
		},
	},
] as const;

export const METHODOLOGY_METRIC_KEY: Readonly<Record<string, MetricKey>> = {
	otp_definition: 'otp',
	delay_unit: 'avgDelay',
	percentiles: 'p50p90',
	headway: 'headway',
	headway_regularity: 'regularityCov',
	service_span: 'serviceSpan',
	skipped_stops: 'skippedStop',
	cancellation: 'cancellation',
	occupancy: 'occupancy',
};

export const METRIC_METHODOLOGY_KEY: Readonly<Partial<Record<MetricKey, string>>> =
	Object.fromEntries(
		Object.entries(METHODOLOGY_METRIC_KEY).map(([provKey, metricKey]) => [metricKey, provKey]),
	) as Partial<Record<MetricKey, string>>;

export function methodologyNoteFor(
	key: MetricKey,
	methodology: Record<string, unknown> | null | undefined,
): string | null {
	if (!methodology) return null;
	const provKey = METRIC_METHODOLOGY_KEY[key];
	if (!provKey) return null;
	const value = methodology[provKey];
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
