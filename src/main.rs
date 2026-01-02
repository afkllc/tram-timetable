use std::collections::HashMap;

use clap::Parser;
use reqwest::header::{self, HeaderMap};

mod parser;

#[derive(Parser, Debug)]
#[clap(author = "Sean Outram", version, about)]
/// Application configuration
struct Args {
    #[arg(long, short, help = "Station Name")]
    station_name: Option<String>,

    #[arg(long, short, help = "The atcocode of the stop")]
    atcocode: Option<String>,
}

#[macro_export]
macro_rules! ternary {
    ($condition: expr => $true_expr: expr , $false_expr: expr) => {
        if $condition {
            $true_expr
        } else {
            $false_expr
        }
    };
}

fn main() {
    let args = Args::parse();

    env_logger::init();

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        "application/x-www-form-urlencoded; charset=UTF-8"
            .parse()
            .unwrap(),
    );
    headers.insert(
        header::USER_AGENT,
        "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
            .parse()
            .unwrap(),
    );
    let client = reqwest::blocking::Client::builder()
        .default_headers(headers)
        .build()
        .unwrap();

    let mut atcocode = args.atcocode.clone();
    if args.atcocode.is_none() {
        let mut station_name = args.station_name.clone();
        if args.station_name.is_none() {
            let station_name_input = inquire::Text::new("Enter the name of a station").prompt();
            station_name = match station_name_input {
                Ok(choice) => Some(choice),
                Err(_) => {
                    println!("No Input made");
                    return;
                }
            };
        }

        let mut station_hash_map: HashMap<String, String> = HashMap::new();

        let station_list = client
        .get(format!("https://journeyplanner.travelsouthyorkshire.com/jpapi/api/destinations/dZSMnv.8dwxeh-f.V6S8jcvvfJR7M-no8QxPgGLzOhc=/{}&type=tram_stop", station_name.unwrap()))
        .send().unwrap().json::<StationListContainer>().unwrap();

        for station in station_list.member {
            station_hash_map.insert(station.name, station.atcocode);
        }

        let selected_station =
            inquire::Select::new("Select a Station", station_hash_map.keys().collect()).prompt();
        let selected_station = match selected_station {
            Ok(choice) => choice,
            Err(_) => return println!("No selection made"),
        };
        atcocode = Some(station_hash_map.get(selected_station).unwrap().to_owned());
    }

    let response = client
            .post("https://journeyplanner.travelsouthyorkshire.com/JourneyPlanner/RefreshBusDeparturesModel")
            .body(format!("fromCode={}", atcocode.unwrap()))
            .send();
    let html = response.unwrap().text().unwrap();
    let departures = parser::parse(html);

    log::info!("Downloaded Departures for stop");

    for departure in departures {
        println!(
            "{} {} {} {}",
            ternary!(departure.live => "LIVE", ""),
            departure.id,
            departure.destination,
            departure.expected_time
        );
    }
}

#[derive(serde::Deserialize)]
struct StationListContainer {
    member: Vec<StationListMember>,
}

#[derive(serde::Deserialize)]
struct StationListMember {
    name: String,
    atcocode: String,
}
