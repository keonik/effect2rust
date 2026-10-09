// Hand-written Rust baseline (see Cargo.toml). Ten tokio-postgres connections; each one
// pipelines the queries issued on it concurrently, like Drogon's fast DB client.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tokio_postgres::{Client, NoTls, Row, Statement};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

struct Conn {
    client: Client,
    find: Statement,
    insert: Statement,
}

struct App {
    conns: Vec<Conn>,
    next: AtomicUsize,
}

impl App {
    fn conn(&self) -> &Conn {
        &self.conns[self.next.fetch_add(1, Ordering::Relaxed) % self.conns.len()]
    }
}

fn todo(row: &Row) -> Value {
    json!({ "id": row.get::<_, i32>(0), "title": row.get::<_, String>(1), "done": row.get::<_, bool>(2) })
}

async fn get_todo(State(app): State<Arc<App>>, Path(id): Path<i64>) -> Response {
    let c = app.conn();
    match c.client.query_opt(&c.find, &[&id]).await {
        Ok(Some(row)) => Json(todo(&row)).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "_tag": "TodoNotFound", "id": id }))).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn create_todo(State(app): State<Arc<App>>, Json(body): Json<Value>) -> Response {
    let Some(title) = body.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let c = app.conn();
    match c.client.query_one(&c.insert, &[&title]).await {
        Ok(row) => (StatusCode::CREATED, Json(todo(&row))).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[tokio::main]
async fn main() {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL");
    let mut conns = Vec::new();
    for _ in 0..10 {
        let (client, connection) = tokio_postgres::connect(&url, NoTls).await.expect("connect");
        tokio::spawn(connection);
        let find = client.prepare("SELECT id, title, done FROM todos WHERE id = $1::int8").await.expect("prepare");
        let insert = client.prepare("INSERT INTO todos (title, done) VALUES ($1, false) RETURNING id, title, done").await.expect("prepare");
        conns.push(Conn { client, find, insert });
    }
    let app = Router::new()
        .route("/todos/{id}", get(get_todo))
        .route("/todos", post(create_todo))
        .with_state(Arc::new(App { conns, next: AtomicUsize::new(0) }));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}
