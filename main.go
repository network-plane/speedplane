package main

import (
	"context"
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"speedplane/api"
	"speedplane/config"
	"speedplane/model"
	"speedplane/scheduler"
	"speedplane/speedtest"
	"speedplane/storage"
	"speedplane/theme"
	"syscall"
	"time"

	"github.com/spf13/cobra"
)

//go:embed templates
var templatesFS embed.FS

//go:embed web/dist
var staticFS embed.FS

var (
	dataDir    string
	dbPath     string
	listen     string
	listenPort int
	public     bool
	appVersion = "0.1.28"
)

var rootCmd = &cobra.Command{
	Use:   "speedplane",
	Short: "speedplane – Speedtest tracker and dashboard",
	Long:  "Speedplane is a tool for tracking internet speedtest results with a web dashboard.",
	Run:   run,
}

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Configuration management",
	Long:  "Manage speedplane configuration files.",
}

var configGenerateCmd = &cobra.Command{
	Use:   "generate",
	Short: "Generate a default configuration file",
	Long:  "Generate a default speedplane.config file in the specified data directory (or current directory if not specified).",
	Run:   runConfigGenerate,
}

var configSystemdCmd = &cobra.Command{
	Use:   "systemd",
	Short: "Generate a systemd service file",
	Long:  "Generate a systemd service file for speedplane in the current directory. Use --deploy to install it to /etc/systemd/system/ and reload systemd.",
	Run:   runConfigSystemd,
}

func init() {
	wd, _ := os.Getwd()
	rootCmd.Version = appVersion
	rootCmd.Flags().StringVar(&dataDir, "data-dir", wd, "Data directory (default: current directory)")
	rootCmd.Flags().StringVar(&dbPath, "db", "", "Database path (full path with filename, or directory to use default filename 'speedplane.results')")
	rootCmd.Flags().StringVar(&listen, "listen", "all", "IP address to listen on (default: all)")
	rootCmd.Flags().IntVar(&listenPort, "listen-port", 8080, "Port to listen on (default: 8080)")
	rootCmd.Flags().BoolVar(&public, "public", false, "Enable public dashboard access")

	configGenerateCmd.Flags().StringVar(&dataDir, "data-dir", wd, "Data directory where config file will be created (default: current directory)")
	configSystemdCmd.Flags().Bool("deploy", false, "Deploy the service file to /etc/systemd/system/ and reload systemd daemon")
	configSystemdCmd.Flags().StringVar(&dataDir, "data-dir", wd, "Data directory to use in the service file (default: current directory)")
	configCmd.AddCommand(configGenerateCmd)
	configCmd.AddCommand(configSystemdCmd)
	rootCmd.AddCommand(configCmd)
}

func run(cmd *cobra.Command, args []string) {
	// Load config from data-dir
	cfg, err := config.Load(dataDir)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// Override config with CLI flags only if they were explicitly provided
	if cmd.Flags().Changed("data-dir") {
		cfg.DataDir = dataDir
	} else if cfg.DataDir != "" && cfg.DataDir != "." {
		// If data-dir flag wasn't provided but config file specifies one, use it
		dataDir = cfg.DataDir
		cfg.DataDir = dataDir
	}

	if cmd.Flags().Changed("listen") || cmd.Flags().Changed("listen-port") {
		if listen != "" && listen != "all" {
			cfg.ListenAddr = fmt.Sprintf("%s:%d", listen, listenPort)
		} else {
			// Listen on all interfaces
			cfg.ListenAddr = fmt.Sprintf(":%d", listenPort)
		}
	}
	if cmd.Flags().Changed("public") {
		cfg.PublicDashboard = public
	}
	if cmd.Flags().Changed("db") {
		cfg.DBPath = dbPath
	}

	// Ensure data directory exists and is absolute
	dataDirAbs, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		log.Fatalf("resolve data dir: %v", err)
	}
	cfg.DataDir = dataDirAbs

	store, err := storage.New(cfg.DBPath, cfg.DataDir)
	if err != nil {
		log.Fatalf("initialize storage: %v", err)
	}
	defer store.Close()

	// Load schedules and lastRun from config
	if cfg.Schedules == nil {
		cfg.Schedules = []model.Schedule{}
	}
	if cfg.LastRun == nil {
		cfg.LastRun = make(map[string]time.Time)
	}

	runner := speedtest.NewRunner()

	runAndSave := func(ctx context.Context) (*model.SpeedtestResult, error) {
		res, err := runner.Run(ctx)
		if err != nil {
			return nil, err
		}
		if err := store.SaveResult(res); err != nil {
			return nil, err
		}
		return res, nil
	}

	// Run without saving (for manual runs when SaveManualRuns is false)
	runWithoutSave := func(ctx context.Context) (*model.SpeedtestResult, error) {
		return runner.Run(ctx)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	sched := scheduler.New(runAndSave, cfg.Schedules, cfg.LastRun)

	// Save config when schedules or lastRun change
	saveConfig := func() {
		cfg.Schedules = sched.Schedules()
		cfg.LastRun = sched.LastRun()
		if err := config.Save(cfg); err != nil {
			log.Printf("failed to save config: %v", err)
		}
	}
	sched.SetOnUpdate(saveConfig)

	// Initialize theme manager
	themeManager, err := theme.NewManager(templatesFS)
	if err != nil {
		log.Fatalf("initialize theme manager: %v", err)
	}
	themeHandler := theme.NewHandler(themeManager)

	// Load index.html template from static files
	indexHTML, err := staticFS.ReadFile("web/dist/index.html")
	if err != nil {
		log.Fatalf("Failed to read index.html: %v", err)
	}
	indexTemplate := template.Must(template.New("index").Parse(string(indexHTML)))

	mux := http.NewServeMux()

	// Create progress-enabled runner that doesn't save (for manual runs when SaveManualRuns is false)
	runWithProgressWithoutSave := func(ctx context.Context, progress func(stage string, message string)) (*model.SpeedtestResult, error) {
		return runner.RunWithProgress(ctx, progress)
	}

	// Getter function for SaveManualRuns preference
	getSaveManualRuns := func() bool {
		return cfg.SaveManualRuns
	}

	// Setter function for SaveManualRuns preference
	setSaveManualRuns := func(value bool) error {
		cfg.SaveManualRuns = value
		return config.Save(cfg)
	}

	apiServer := api.NewServer(store, runWithoutSave, runWithProgressWithoutSave, sched, saveConfig, getSaveManualRuns, setSaveManualRuns)

	// Broadcast when scheduled speedtests complete
	sched.SetOnComplete(func(result *model.SpeedtestResult) {
		apiServer.BroadcastSpeedtestComplete(result)
	})

	apiServer.Register(mux)
	sched.Start(ctx)

	// Theme API endpoints
	mux.HandleFunc("/api/theme", themeHandler.HandleTheme)
	mux.HandleFunc("/api/schemes", themeHandler.HandleSchemes)

	// Index page handler
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}

		defaultTemplate := "speedplane"
		defaultScheme := "default"
		templatesList := themeManager.ListTemplates()
		if len(templatesList) > 0 {
			defaultTemplate = templatesList[0]
			if templateInfo := themeManager.GetTemplate(defaultTemplate); templateInfo != nil {
				for schemeName := range templateInfo.Schemes {
					defaultScheme = schemeName
					break
				}
			}
		}

		templateName := defaultTemplate
		schemeName := defaultScheme

		templateMenuHTML := themeHandler.GenerateTemplateMenuHTML(templateName)
		schemeMenuHTML := themeHandler.GenerateSchemeMenuHTML(templateName)

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = indexTemplate.Execute(w, map[string]any{
			"Title":            "speedplane",
			"TemplatesList":    templatesList,
			"TemplateMenuHTML": template.HTML(templateMenuHTML),
			"SchemeMenuHTML":   template.HTML(schemeMenuHTML),
			"CurrentTemplate":  templateName,
			"CurrentScheme":    schemeName,
			"AppVersion":       appVersion,
			"Year":             time.Now().Year(),
		})
	})

	// Static files
	staticContent, err := fs.Sub(staticFS, "web/dist")
	if err != nil {
		log.Fatalf("Failed to create static file sub-filesystem: %v", err)
	}

	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticContent))))

	// Serve JS/CSS files directly
	mux.HandleFunc("/main.js", func(w http.ResponseWriter, r *http.Request) {
		content, err := staticFS.ReadFile("web/dist/main.js")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Write(content)
	})
	mux.HandleFunc("/main.js.map", func(w http.ResponseWriter, r *http.Request) {
		content, err := staticFS.ReadFile("web/dist/main.js.map")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Write(content)
	})
	mux.HandleFunc("/styles.css", func(w http.ResponseWriter, r *http.Request) {
		// Styles are now loaded via theme API, but keep for backwards compatibility
		http.NotFound(w, r)
	})

	srv := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: mux,
	}

	// Print listening addresses
	printListeningAddresses(cfg.ListenAddr)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
}

func runConfigGenerate(cmd *cobra.Command, args []string) {
	// Ensure data directory exists and is absolute
	dataDirAbs, err := filepath.Abs(dataDir)
	if err != nil {
		log.Fatalf("resolve data dir: %v", err)
	}

	// Create default config
	cfg := config.Default()
	cfg.DataDir = dataDirAbs
	cfg.DBPath = filepath.Join(dataDirAbs, "speedplane.results")

	// Check if config file already exists
	cfgPath := filepath.Join(dataDirAbs, "speedplane.config")
	if _, err := os.Stat(cfgPath); err == nil {
		log.Fatalf("config file already exists: %s", cfgPath)
	}

	// Save default config
	if err := config.Save(cfg); err != nil {
		log.Fatalf("failed to save config: %v", err)
	}

	fmt.Printf("Generated default config file: %s\n", cfgPath)
}

func runConfigSystemd(cmd *cobra.Command, args []string) {
	deploy, _ := cmd.Flags().GetBool("deploy")

	// Get the binary path
	binPath, err := os.Executable()
	if err != nil {
		log.Fatalf("failed to get executable path: %v", err)
	}
	binPath, err = filepath.Abs(binPath)
	if err != nil {
		log.Fatalf("failed to resolve binary path: %v", err)
	}

	// Get data directory - use flag if explicitly set, otherwise try to load from config
	var dataDirToUse string
	var cfg config.Config
	if cmd.Flags().Changed("data-dir") {
		dataDirToUse = dataDir
		// Load config to get db path
		cfg, _ = config.Load(dataDir)
	} else {
		// Try to load from config in current directory or default location
		cfg, err = config.Load(dataDir)
		if err == nil && cfg.DataDir != "" && cfg.DataDir != "." {
			dataDirToUse = cfg.DataDir
		} else {
			dataDirToUse = dataDir
		}
	}
	dataDirAbs, err := filepath.Abs(dataDirToUse)
	if err != nil {
		log.Fatalf("resolve data dir: %v", err)
	}

	// Resolve db path (using the same logic as storage.New)
	var dbPathToUse string
	if cfg.DBPath == "" {
		dbPathToUse = filepath.Join(dataDirAbs, "speedplane.results")
	} else {
		// Use the db path from config as-is (it will be resolved by storage.New)
		dbPathToUse = cfg.DBPath
		// If it's relative, make it absolute relative to dataDir
		if !filepath.IsAbs(dbPathToUse) {
			dbPathToUse = filepath.Join(dataDirAbs, dbPathToUse)
		}
	}

	// Get current user for the service
	currentUser, err := user.Current()
	if err != nil {
		log.Fatalf("failed to get current user: %v", err)
	}

	// Build ExecStart command with all necessary flags
	execStart := fmt.Sprintf("%s --data-dir %s --db %s", binPath, dataDirAbs, dbPathToUse)

	// Generate service file content
	serviceContent := fmt.Sprintf(`[Unit]
Description=Speedplane - Speedtest tracker and dashboard
After=network.target

[Service]
Type=simple
User=%s
Group=%s
WorkingDirectory=%s
ExecStart=%s
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=speedplane

[Install]
WantedBy=multi-user.target
`, currentUser.Username, currentUser.Username, dataDirAbs, execStart)

	// Write service file to current directory
	wd, err := os.Getwd()
	if err != nil {
		log.Fatalf("failed to get working directory: %v", err)
	}
	serviceFilePath := filepath.Join(wd, "speedplane.service")

	// Check if service file already exists
	if _, err := os.Stat(serviceFilePath); err == nil {
		log.Fatalf("service file already exists: %s", serviceFilePath)
	}

	if err := os.WriteFile(serviceFilePath, []byte(serviceContent), 0644); err != nil {
		log.Fatalf("failed to write service file: %v", err)
	}

	fmt.Printf("Generated systemd service file: %s\n", serviceFilePath)

	if deploy {
		// Copy to /etc/systemd/system/
		targetPath := "/etc/systemd/system/speedplane.service"
		fmt.Printf("Copying service file to %s...\n", targetPath)

		// Use sudo cp to copy the file
		cpCmd := exec.Command("sudo", "cp", serviceFilePath, targetPath)
		cpCmd.Stdout = os.Stdout
		cpCmd.Stderr = os.Stderr
		if err := cpCmd.Run(); err != nil {
			log.Fatalf("failed to copy service file: %v", err)
		}

		// Set proper permissions
		chmodCmd := exec.Command("sudo", "chmod", "644", targetPath)
		if err := chmodCmd.Run(); err != nil {
			log.Fatalf("failed to set permissions: %v", err)
		}

		// Reload systemd daemon
		fmt.Println("Reloading systemd daemon...")
		reloadCmd := exec.Command("sudo", "systemctl", "daemon-reload")
		reloadCmd.Stdout = os.Stdout
		reloadCmd.Stderr = os.Stderr
		if err := reloadCmd.Run(); err != nil {
			log.Fatalf("failed to reload systemd daemon: %v", err)
		}

		fmt.Printf("Service file deployed successfully!\n")
		fmt.Printf("You can now start the service with: sudo systemctl start speedplane\n")
		fmt.Printf("Enable it to start on boot with: sudo systemctl enable speedplane\n")
	}
}

func printListeningAddresses(addr string) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		log.Printf("listening on http://%s", addr)
		return
	}

	if host == "" || host == "0.0.0.0" || host == "::" {
		// Listening on all interfaces
		addrs, err := net.InterfaceAddrs()
		if err == nil {
			log.Println("listening on:")
			for _, a := range addrs {
				if ipnet, ok := a.(*net.IPNet); ok && !ipnet.IP.IsLoopback() {
					if ipnet.IP.To4() != nil {
						log.Printf("  http://%s:%s", ipnet.IP.String(), port)
					}
				}
			}
			// Also show localhost
			log.Printf("  http://localhost:%s", port)
			log.Printf("  http://127.0.0.1:%s", port)
		} else {
			log.Printf("listening on http://0.0.0.0:%s", port)
		}
	} else {
		log.Printf("listening on http://%s:%s", host, port)
	}
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
