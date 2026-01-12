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
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"speedplane/api"
	"speedplane/config"
	"speedplane/model"
	"speedplane/scheduler"
	"speedplane/speedtest"
	"speedplane/storage"
	"speedplane/theme"
)

//go:embed templates
var templatesFS embed.FS

//go:embed web/dist
var staticFS embed.FS

var (
	dataDir    string
	listen     string
	listenPort int
	public     bool
	appVersion = "0.1.8"
)

var rootCmd = &cobra.Command{
	Use:   "speedplane",
	Short: "speedplane – Speedtest tracker and dashboard",
	Long:  "Speedplane is a tool for tracking internet speedtest results with a web dashboard.",
	Run:   run,
}

func init() {
	wd, _ := os.Getwd()
	rootCmd.Version = appVersion
	rootCmd.Flags().StringVar(&dataDir, "data-dir", wd, "Data directory (default: current directory)")
	rootCmd.Flags().StringVar(&listen, "listen", "all", "IP address to listen on (default: all)")
	rootCmd.Flags().IntVar(&listenPort, "listen-port", 8080, "Port to listen on (default: 8080)")
	rootCmd.Flags().BoolVar(&public, "public", false, "Enable public dashboard access")
}

func run(cmd *cobra.Command, args []string) {
	// Load config from data-dir
	cfg, err := config.Load(dataDir)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	// Override config with CLI flags
	cfg.DataDir = dataDir
	if listen != "" && listen != "all" {
		cfg.ListenAddr = fmt.Sprintf("%s:%d", listen, listenPort)
	} else {
		// Listen on all interfaces
		cfg.ListenAddr = fmt.Sprintf(":%d", listenPort)
	}
	cfg.PublicDashboard = public

	// Ensure data directory exists and is absolute
	dataDirAbs, err := filepath.Abs(cfg.DataDir)
	if err != nil {
		log.Fatalf("resolve data dir: %v", err)
	}
	cfg.DataDir = dataDirAbs

	store := storage.New(cfg.DataDir)
	if err := store.EnsureDirs(); err != nil {
		log.Fatalf("ensure data dir: %v", err)
	}

	schedules, err := store.LoadSchedules()
	if err != nil {
		log.Fatalf("load schedules: %v", err)
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

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	sched := scheduler.New(runAndSave, schedules)
	sched.Start(ctx)

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

	// Create progress-enabled runner
	runWithProgress := func(ctx context.Context, progress func(stage string, message string)) (*model.SpeedtestResult, error) {
		res, err := runner.RunWithProgress(ctx, progress)
		if err != nil {
			return nil, err
		}
		if err := store.SaveResult(res); err != nil {
			return nil, err
		}
		return res, nil
	}

	apiServer := api.NewServer(store, runAndSave, runWithProgress, sched)
	apiServer.Register(mux)

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
