pub fn parse(html: String) -> Vec<DepartureInfo> {
    let document = scraper::Html::parse_document(&html);

    let departures_row_selector = scraper::Selector::parse(".departures-tr-bus").unwrap();
    let departures_service_selector =
        scraper::Selector::parse(".busDepartService.busTramServices p").unwrap();
    let departures_destination_selector = scraper::Selector::parse(".live-departure-rows").unwrap();
    let departures_live_selector =
        scraper::Selector::parse(".live-icon-container img.live-icon").unwrap();
    let departures_expected_time_selector =
        scraper::Selector::parse(".busTramServices.busTramExpected p").unwrap();

    let departures_rows = document.select(&departures_row_selector);
    let mut departures = Vec::new();

    for departure in departures_rows {
        let mut current_service_id = String::new();
        let mut current_destination = String::new();
        let mut current_live = false;

        let service = departure.select(&departures_service_selector);
        for service_elem in service {
            if let Some(service_id) = service_elem.text().next() {
                current_service_id = service_id.trim().to_string();
            }
        }

        let destination = departure.select(&departures_destination_selector);
        for destination_elem in destination {
            if let Some(destination_name) = destination_elem.text().next() {
                current_destination = destination_name.trim().to_string();
            }
        }

        let live = departure.select(&departures_live_selector);
        for live_elem in live {
            if let Some(alt_text) = live_elem.value().attr("alt") {
                current_live = !alt_text.is_empty();
            }
        }

        let expected_time = departure.select(&departures_expected_time_selector);
        for expected_time_elem in expected_time {
            if let Some(expected_time) = expected_time_elem.text().next() {
                let info = DepartureInfo {
                    id: current_service_id.clone(),
                    destination: current_destination.clone(),
                    expected_time: expected_time.trim().to_string(),
                    live: current_live,
                };
                departures.push(info);
            }
        }
    }
    log::debug!("All departures: {:#?}", departures);
    departures
}

#[derive(Default, Debug, Clone)]
pub struct DepartureInfo {
    pub id: String,
    pub destination: String,
    pub expected_time: String,
    pub live: bool,
}
