// src/bin/olympic_to_city.rs
use regex::Regex;
use reqwest::Client;
use std::env;
use std::time::Instant;
use tokio::time::{sleep, Duration};

const STOP_URL: &str = "https://bustimes.org/stops/9400ZZSYDVS1";
const STOP_ATCO: &str = "9400ZZSYDVS1";
const MAX_RESULTS: usize = 4;

async fn fetch_times(client: &Client, url: &str) -> Result<Vec<String>, reqwest::Error> {
    let resp = client.get(url).send().await?;
    let text = resp.text().await?;

    // Find a nearby anchor to restrict the search (makes parsing slightly more reliable)
    // Prefer "To Scheduled" marker (seen on the page), fall back to whole page.
    let anchor = "To Scheduled";
    let slice = if let Some(idx) = text.find(anchor) {
        &text[idx..]
    } else {
        &text
    };

    // Regex for 24-hour times HH:MM
    let re = Regex::new(r"\b([01]\d|2[0-3]):[0-5]\d\b").unwrap();

    // collect unique times in order
    let mut times: Vec<String> = Vec::new();
    for cap in re.captures_iter(slice) {
        let t = cap.get(0).unwrap().as_str().to_string();
        if times.last().map_or(true, |last| last != &t) {
            times.push(t);
        }
        if times.len() >= 20 {
            break;
        }
    }

    Ok(times)
}

#[tokio::main]
async fn main() {
    // Polling interval (seconds). Default 30, but can be overridden with POLL_SECS env var.
    let poll_secs: u64 = env::var("POLL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);

    let client = Client::builder()
        .user_agent("supertram-next-departures/1.0 (+https://example.org)")
        .build()
        .expect("failed to build reqwest client");

    println!(
        "Fetching Olympic → City (atcocode {}) every {}s",
        STOP_ATCO, poll_secs
    );
    println!();

    loop {
        let started = Instant::now();
        match fetch_times(&client, STOP_URL).await {
            Ok(times) => {
                println!("OLYMPIC → CITY (stop {})", STOP_ATCO);
                println!("----------------------------");

                if times.is_empty() {
                    println!("(no times found on page)");
                } else {
                    for t in times.iter().take(MAX_RESULTS) {
                        println!("{}", t);
                    }
                }

                println!();
                // helpful debug: show when we last fetched
                println!("Last checked: {}s ago", started.elapsed().as_secs());
                println!();
            }
            Err(e) => {
                eprintln!("Error fetching/parsing: {}", e);
            }
        }

        sleep(Duration::from_secs(poll_secs)).await;
    }
}
