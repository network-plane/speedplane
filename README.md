# speedplane

Speedplane is a tool for tracking internet speedtest results with a web dashboard. It runs speedtests on a schedule (or manually) and provides a web UI to view historical results and manage schedules.

## Features

- Automated speedtest scheduling (interval-based or daily at specific times)
- Web dashboard for viewing results and statistics
- REST API for programmatic access
- Historical data tracking with charts and metrics
- Configurable via config file or command-line flags

## Screenshots
### All graphs
<img width="1478" height="1264" alt="dashboard-all-graphs" src="https://github.com/user-attachments/assets/07dc66e6-e722-4df4-9dcc-9bfc72f868c6" />

### Single Graph (log)
<img width="1499" height="565" alt="dashboard-combined-graph" src="https://github.com/user-attachments/assets/d24971ac-e899-436b-a793-f47c8922c8cd" />

### Results
<img width="1488" height="317" alt="results" src="https://github.com/user-attachments/assets/ffe3c4a3-fae4-438a-bcbf-b95ea094ee1a" />

### Preferences
<img width="1497" height="521" alt="preferences" src="https://github.com/user-attachments/assets/b25c48db-1aa0-4774-94a7-c868944e6615" />


## Installation

### Building from source

```bash
make build
```

Or manually:

```bash
# Build frontend
make frontend

# Build backend
go build -o speedplane .
```

## Configuration

Speedplane can be configured via a config file or command-line flags. The config file `speedplane.config` should be placed in the data directory (default: current directory).

### Config File Format

Create a `speedplane.config` file in your data directory:

```json
{
  "data_dir": "/path/to/data",
  "db_path": "/path/to/database.results",
  "listen_addr": ":8080",
  "public_dashboard": false
}
```

### Command-Line Flags

- `--data-dir string` - Data directory (default: current directory)
- `--db string` - Database path (full path with filename, or directory to use default filename 'speedplane.results')
- `--listen string` - IP address to listen on (default: "all" - listens on all interfaces)
- `--listen-port int` - Port to listen on (default: 8080)
- `--public` - Enable public dashboard access (default: false)
- `--version, -v` - Print version information
- `--help, -h` - Show help message

Command-line flags override values from the config file.

## Usage

### Basic Usage

Start speedplane with default settings (listens on all interfaces, port 8080):

```bash
./speedplane
```

### Custom Data Directory

```bash
./speedplane --data-dir /var/lib/speedplane
```

### Listen on Specific Interface

```bash
./speedplane --listen 127.0.0.1 --listen-port 8080
```

### Enable Public Dashboard

```bash
./speedplane --public
```

### Check Version

```bash
./speedplane --version
```

## Web Interface

Once started, speedplane will print the HTTP addresses it's listening on. Access the web dashboard at:

- `http://localhost:8080` (when listening on all interfaces)
- Or the specific address shown in the startup output

The web interface provides:
- Dashboard with latest results and charts
- Historical results table
- Schedule management

## API Endpoints

- `GET /api/health` - Health check
- `GET /api/summary` - Get summary statistics
- `GET /api/history?from=...&to=...` - Get historical results
- `POST /api/run` - Run a speedtest immediately
- `GET /api/schedules` - List all schedules
- `POST /api/schedules` - Create a new schedule
- `GET /api/schedules/{id}` - Get a specific schedule
- `PUT /api/schedules/{id}` - Update a schedule
- `DELETE /api/schedules/{id}` - Delete a schedule

## Schedules

Schedules can be created via the API or web interface. Two types are supported:

- **Interval**: Run every X duration (e.g., "1h", "30m", "6h")
- **Daily**: Run at a specific time each day (e.g., "14:30")

## Data Storage

Speedtest results are stored in a SQLite database. By default, the database is stored as `speedplane.results` in the data directory. You can customize the database path using the `--db` flag or `db_path` config option:

- If `db_path` is empty: uses `{data_dir}/speedplane.results`
- If `db_path` is a directory: uses `{db_path}/speedplane.results`
- If `db_path` is a full path with filename: uses it as-is

```
data-dir/
  speedplane.results  # SQLite database containing all speedtest results (default)
  speedplane.config
```

## Template Subsmissions
 - Youtube [MrPewPewLaser](https://github.com/MrPewPewLaser)

## License

See LICENSE file for details.
