import tkinter as tk
from tkinter import ttk, messagebox
import requests
import json
import time
import random
import threading
import pandas as pd  
import oracledb 

class ScrollableFrame(ttk.Frame):
    """Reusable scrollable frame with auto-width expansion and native mousewheel support"""
    def __init__(self, parent, *args, **kwargs):
        super().__init__(parent, *args, **kwargs)
        self.canvas = tk.Canvas(self, borderwidth=0, highlightthickness=0, bg="#f8fafc")
        self.scrollbar = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.content = ttk.Frame(self.canvas, style="Main.TFrame")

        self.content.bind(
            "<Configure>",
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        )
        self.canvas_window = self.canvas.create_window((0, 0), window=self.content, anchor="nw")
        self.canvas.bind(
            "<Configure>",
            lambda e: self.canvas.itemconfig(self.canvas_window, width=e.width)
        )
        self.canvas.configure(yscrollcommand=self.scrollbar.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.scrollbar.pack(side="right", fill="y")

class APIToolApp:
    def __init__(self, root):
        self.root = root
        self.root.title("BRM API Tester (Billing Account & Order Management)")
        self.root.geometry("1020x920") 
        self.root.minsize(880, 720)
        self.root.configure(bg="#f1f5f9")
        
        # --- Theme & Styles ---
        self.setup_styles()
        
        # --- ตั้งค่าดึงข้อมูล SERVICE_ID จาก Google Sheets ---
        self.sheet_id = "13wmhE6b0iUcYB2meHoAkyBqwWZ6Ok3oOoBzy2fGineY"  
        self.sheet_gid = "0" 
        
        self.service_mapping = {}
        self.service_list = []
        
        # --- ตั้งค่า Database Connection (Oracle) ---
        self.db_user = "pin"
        self.db_password = "pin"
        self.db_dsn = "10.44.82.110:1521/tbrmdb" # แก้ไขเอา _ ออกแล้ว
        
        # เปลี่ยนเป็นโครงสร้างเก็บข้อมูล: { SERVICE_ID: { DEAL_NAME: PLAN_NAME } }
        self.service_deal_mapping = {} 
        
        # API Endpoints Mapping
        self.api_urls = {
            "BA": {
                "DEV": "http://10.44.82.106:7500/brm-api/v1/account/createBillingAccount",
                "PROD": "http://10.44.81.307:7500/brm-api/v1/account/createBillingAccount",
                "NEW DB": "http://10.44.82.222:7500/brm-api/v1/account/createBillingAccount"
            },
            "ORDER": {
                "DEV": "http://10.44.82.106:7500/brm-api/v1/subscription/createOrder",
                "PROD": "http://10.44.81.307:7500/brm-api/v1/subscription/createOrder",
                "NEW DB": "http://10.44.82.222:7500/brm-api/v1/subscription/createOrder"
            }
        }
        
        # --- Main Layout Split ---
        self.main_pane = ttk.PanedWindow(root, orient='vertical')
        self.main_pane.pack(fill='both', expand=True, padx=12, pady=10)
        
        self.tabs_frame = ttk.Frame(self.main_pane, style="Main.TFrame")
        self.main_pane.add(self.tabs_frame, weight=3) 
        
        self.notebook = ttk.Notebook(self.tabs_frame)
        self.notebook.pack(fill='both', expand=True)
        
        self.tab_ba = ttk.Frame(self.notebook, style="Main.TFrame")
        self.tab_order = ttk.Frame(self.notebook, style="Main.TFrame")
        
        self.notebook.add(self.tab_ba, text="  📋 1. Create Billing Account (BA)  ")
        self.notebook.add(self.tab_order, text="  🛒 2. Create Order & Services  ")
        
        self.setup_console_log()
        
        self.setup_ba_tab()
        self.setup_order_tab()

        # Global Mousewheel binding
        self.root.bind_all("<MouseWheel>", self._on_global_mousewheel)

        # โหลดข้อมูลเบื้องหลัง (Background Thread ไม่บล็อก GUI ตอนเริ่ม)
        threading.Thread(target=self._init_data_loading, daemon=True).start()

    def setup_styles(self):
        style = ttk.Style()
        style.theme_use('clam')

        BG_MAIN = "#f8fafc"
        CARD_BG = "#ffffff"
        BORDER_COLOR = "#cbd5e1"

        style.configure("Main.TFrame", background=BG_MAIN)
        style.configure("TNotebook", background=BG_MAIN, borderwidth=0)
        style.configure("TNotebook.Tab", font=("Segoe UI", 10, "bold"), padding=[18, 7])
        style.map("TNotebook.Tab",
                  background=[("selected", CARD_BG), ("active", "#e2e8f0")],
                  foreground=[("selected", "#1e40af"), ("!selected", "#64748b")])

        style.configure("TLabelframe", background=CARD_BG, relief="solid", borderwidth=1, bordercolor=BORDER_COLOR)
        style.configure("TLabelframe.Label", font=("Segoe UI", 10, "bold"), foreground="#1e40af", background=CARD_BG)
        style.configure("Card.TFrame", background=CARD_BG)

        style.configure("TLabel", background=CARD_BG, font=("Segoe UI", 9), foreground="#334155")
        style.configure("FieldLabel.TLabel", background=CARD_BG, font=("Segoe UI", 9, "bold"), foreground="#1e293b")
        style.configure("Hint.TLabel", background=CARD_BG, font=("Segoe UI", 8), foreground="#64748b")
        style.configure("Status.TLabel", background="#1e293b", font=("Segoe UI", 9), foreground="#94a3b8")

        style.configure("Primary.TButton", font=("Segoe UI", 10, "bold"), padding=[16, 8], foreground="#ffffff", background="#2563eb")
        style.map("Primary.TButton",
                  background=[("active", "#1d4ed8"), ("disabled", "#94a3b8")])

        style.configure("ActionBA.TButton", font=("Segoe UI", 11, "bold"), padding=[20, 10], foreground="#ffffff", background="#059669")
        style.map("ActionBA.TButton",
                  background=[("active", "#047857"), ("disabled", "#94a3b8")])

        style.configure("ActionOrder.TButton", font=("Segoe UI", 11, "bold"), padding=[20, 10], foreground="#ffffff", background="#2563eb")
        style.map("ActionOrder.TButton",
                  background=[("active", "#1d4ed8"), ("disabled", "#94a3b8")])

        style.configure("Secondary.TButton", font=("Segoe UI", 9), padding=[8, 4])
        style.configure("Readonly.TEntry", fieldbackground="#f1f5f9", foreground="#0f172a")

    def _on_global_mousewheel(self, event):
        focused = self.root.focus_get()
        if focused and isinstance(focused, tk.Text):
            return
        current_tab = self.notebook.index(self.notebook.select())
        canvas = self.ba_scroll.canvas if current_tab == 0 else self.order_scroll.canvas
        canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    def _init_data_loading(self):
        self.load_service_data()
        self.load_database_data()
        self.root.after(0, self._post_init_ui)

    def _post_init_ui(self):
        if hasattr(self, 'srv_cb') and self.service_list:
            self.srv_cb['values'] = self.service_list
            self.srv_cb.set(self.service_list[0])
            self.on_service_id_selected()
        self.update_status_indicator()

    def update_status_indicator(self):
        srv_count = len(self.service_list)
        deal_count = sum(len(deals) for deals in self.service_deal_mapping.values())
        status_text = f"📊 ฐานข้อมูล: {deal_count} Deals ({len(self.service_deal_mapping)} Services)  |  🌐 Google Sheet: {srv_count} Services"
        if hasattr(self, 'status_label'):
            self.status_label.config(text=status_text)

    def load_service_data(self):
        csv_url = f"https://docs.google.com/spreadsheets/d/{self.sheet_id}/gviz/tq?tqx=out:csv&gid={self.sheet_gid}"
        try:
            df = pd.read_csv(csv_url)
            required_cols = ['SERVICE_ID', 'GROUP_ID', 'PROP_1_TYPE', 'PROP_2_TYPE']
            if all(col in df.columns for col in required_cols):
                df_filtered = df[df['GROUP_ID'] == 1].copy()
                df_filtered['SERVICE_ID'] = df_filtered['SERVICE_ID'].astype(str)
                
                def format_value(val):
                    if pd.isna(val): return ""
                    if isinstance(val, (float, int)) and float(val).is_integer(): return str(int(val))
                    return str(val)
                
                df_filtered['PROP_1_TYPE'] = df_filtered['PROP_1_TYPE'].apply(format_value)
                df_filtered['PROP_2_TYPE'] = df_filtered['PROP_2_TYPE'].apply(format_value)
                
                self.service_mapping = df_filtered.set_index('SERVICE_ID')[['PROP_1_TYPE', 'PROP_2_TYPE']].to_dict('index')
                self.service_list = sorted(list(self.service_mapping.keys()), key=lambda x: int(x) if x.isdigit() else x)
                self.log_message(f"ดึงข้อมูลสำเร็จ! พบ {len(self.service_list)} Services บน Google Sheet")
            else:
                self.service_list = ["110"]
        except Exception as e:
            self.log_message(f"ไม่สามารถดึงข้อมูลจาก Google Sheet ได้เนื่องจาก: {e}")
            self.service_list = ["110"] 

    def load_database_data(self):
        connection = None
        cursor = None
        try:
            self.log_message("[Database] กำลังเชื่อมต่อฐานข้อมูล Oracle...")
            connection = oracledb.connect(user=self.db_user, password=self.db_password, dsn=self.db_dsn)
            cursor = connection.cursor()
            self.log_message("[Database] เชื่อมต่อสำเร็จ! กำลังรัน Query จัดกลุ่ม DEAL_NAME ตาม SERVICE_ID...")

            sql_query = """
            SELECT DISTINCT 
                s.SERVICE_ID ,
                rb.gl_id,
                rb.scaled_amount,
                s.service_type     service_name,
                ps.service_obj_type,
                pl.name                    plan_name,
                pl.descr                   plan_descr,
                dl.name                    deal_name,
                dl.descr                   deal_descr,
                pr.name                    prod_name,
                pr.descr                   prod_descr,
                rp.event_type,
               decode(rp.event_type, '/event/billing/product/fee/cycle/cycle_forward_arrear', 'Monthly', '/event/billing/product/fee/cycle/cycle_forward_monthly', 'Monthly',
                                                      '/event/billing/product/fee/cycle/cycle_forward_annual', 'Yearly' ,'/event/billing/product/fee/cycle/cycle_forward_semiannual', 'Twice a year', 
                                                      '/event/billing/product/fee/cycle/cycle_forward_quarterly', 'Quarterly', event_type) event_type, 
                decode (rp.currency, 840,'US Dollars', 764 ,'Thai Baht', 'no') currency,
                decode(r.prorate_first, 703, 'No_Charge', 702 , 'Prorate', 701, 'Full',prorate_first) prorate_start,
                 decode(r.prorate_last, 703, 'No_Charge', 702, 'Prorate', 701, 'Full',prorate_last)   prorate_end,
                r.descr                    rate_descr,
                rq.step_min , 
                rq.step_max ,
                rb.element_id,
                rb.fix_amount,
                TV.GL_ACCOUNT_STR  SAP_CODE,
                rp.tax_code
            FROM
                plan_t                pl,
                plan_services_t       ps,
                plan_services_deals_t psd,
                deal_t                dl,
                deal_products_t       dp,
                product_t             pr,
                rate_plan_t           rp,
                rate_t                r,
                rate_bal_impacts_t    rb,
                CONFIG_NTH_SERVICE_TYPES_T   s,
                RATE_QUANTITY_TIERS_T rq,
                NTH_SAP_GLID_MAPPING_T TV
            WHERE
                    pl.poid_id0 = ps.obj_id0
                AND s.service_class = ps.service_obj_type
                AND ps.obj_id0 = psd.obj_id0
                AND psd.deal_obj_id0 = dl.poid_id0
                AND dl.poid_id0 = dp.obj_id0
                AND dp.product_obj_id0 = pr.poid_id0
                AND pr.poid_id0 = rp.product_obj_id0
                AND rp.poid_id0 = r.rate_plan_obj_id0
                AND r.poid_id0 = rb.obj_id0
                AND  rb.REC_ID2 = rq.REC_ID              
                AND rq.OBJ_ID0 = rb.OBJ_ID0  
                AND TV.GL_ID = rb.gl_id
                And rp.currency = 764
            Order by s.SERVICE_ID ,  pl.name, dl.name
            """
            
            cursor.execute(sql_query)
            columns = [col[0] for col in cursor.description]
            
            self.service_deal_mapping = {}
            count = 0
            for row in cursor.fetchall():
                row_dict = dict(zip(columns, row))
                srv_id = str(row_dict.get('SERVICE_ID', ''))
                prod_name = str(row_dict.get('PROD_NAME', ''))
                deal_name = str(row_dict.get('DEAL_NAME', ''))
                plan_name = str(row_dict.get('PLAN_NAME', ''))
                
                # เก็บข้อมูลโดยแยกว่า DEAL_NAME นี้อยู่ภายใต้ SERVICE_ID อะไร
                if prod_name.endswith('_00'):
                    if srv_id not in self.service_deal_mapping:
                        self.service_deal_mapping[srv_id] = {}
                    self.service_deal_mapping[srv_id][deal_name] = plan_name
                    count += 1

            self.log_message(f"[Database] โหลดข้อมูล DEAL_NAME เสร็จสิ้น (พบ {count} รายการที่จัดกลุ่มตาม Service ID)")
            
        except Exception as e:
            self.log_message(f"[Database Error] ไม่สามารถดึงข้อมูลได้: {e}")
            self.service_deal_mapping = {}
        finally:
            if cursor: cursor.close()
            if connection: connection.close()

    def generate_thai_id(self):
        digits = [random.randint(1, 6)]
        digits.extend([random.randint(0, 9) for _ in range(11)])
        sum_val = sum(digits[i] * (13 - i) for i in range(12))
        check_digit = (11 - (sum_val % 11)) % 10
        digits.append(check_digit)
        return "".join(map(str, digits))

    def create_form_row(self, parent, label_text, str_var, row, width=46, hint=None, readonly=False):
        lbl = ttk.Label(parent, text=label_text, style="FieldLabel.TLabel")
        lbl.grid(row=row, column=0, sticky='w', padx=(14, 10), pady=4)

        state_mode = 'readonly' if readonly else 'normal'
        style_name = 'Readonly.TEntry' if readonly else None
        entry = ttk.Entry(parent, textvariable=str_var, width=width, state=state_mode, style=style_name)
        entry.grid(row=row, column=1, sticky='w', padx=(0, 14), pady=4)

        if hint:
            hint_lbl = ttk.Label(parent, text=hint, style="Hint.TLabel")
            hint_lbl.grid(row=row, column=2, sticky='w', padx=(4, 10), pady=4)
        return entry

    def setup_console_log(self):
        log_container = ttk.LabelFrame(self.main_pane, text=" 🖥️ Console & Response Log ")
        self.main_pane.add(log_container, weight=1)

        # Top Bar in Log Panel
        top_bar = tk.Frame(log_container, bg="#1e293b")
        top_bar.pack(fill='x', padx=6, pady=(4, 2))

        self.status_label = ttk.Label(top_bar, text="⏳ กำลังเชื่อมต่อข้อมูล...", style="Status.TLabel")
        self.status_label.pack(side='left', padx=8, pady=4)

        btn_box = tk.Frame(top_bar, bg="#1e293b")
        btn_box.pack(side='right', padx=4)

        ttk.Button(btn_box, text="📋 Copy Log", command=self.copy_log, style="Secondary.TButton").pack(side='left', padx=3)
        ttk.Button(btn_box, text="🗑️ Clear Log", command=self.clear_log, style="Secondary.TButton").pack(side='left', padx=3)

        # Log Text Box
        text_frame = tk.Frame(log_container, bg="#0f172a")
        text_frame.pack(fill='both', expand=True, padx=6, pady=(0, 6))

        self.console_text = tk.Text(
            text_frame, height=8, bg="#0f172a", fg="#4ade80",
            insertbackground="#ffffff", font=("Consolas", 10),
            state='disabled', wrap='word', relief='flat', padx=8, pady=6
        )
        self.console_text.pack(side='left', fill='both', expand=True)

        scrollbar = ttk.Scrollbar(text_frame, orient="vertical", command=self.console_text.yview)
        scrollbar.pack(side='right', fill='y')
        self.console_text.configure(yscrollcommand=scrollbar.set)

        self.log_message("✅ ระบบพร้อมใช้งาน - เลือกแท็บด้านบนเพื่อยิง API Create BA หรือ Create Order")

    def log_message(self, message):
        if not hasattr(self, 'console_text'):
            return
        ts = time.strftime('%H:%M:%S')
        formatted = f"[{ts}] {message}"

        def _append():
            self.console_text.config(state='normal')
            self.console_text.insert("1.0", formatted + "\n\n")
            self.console_text.yview_moveto(0)
            self.console_text.config(state='disabled')

        if threading.current_thread() is threading.main_thread():
            _append()
        else:
            self.root.after(0, _append)

    def clear_log(self):
        self.console_text.config(state='normal')
        self.console_text.delete(1.0, tk.END)
        self.console_text.config(state='disabled')

    def copy_log(self):
        self.root.clipboard_clear()
        content = self.console_text.get(1.0, tk.END).strip()
        self.root.clipboard_append(content)
        messagebox.showinfo("สำเร็จ", "คัดลอก Log ทั้งหมดลง Clipboard แล้ว")

    def update_ba_url(self, event=None):
        env = self.ba_env_var.get()
        self.ba_url_var.set(self.api_urls["BA"][env])
        self.log_message(f"[BA] สลับ Environment เป็น: {env}")

    def update_order_url(self, event=None):
        env = self.od_env_var.get()
        self.od_url_var.set(self.api_urls["ORDER"][env])
        self.log_message(f"[ORDER] สลับ Environment เป็น: {env}")

    # ==========================================
    # ฟังก์ชันเมื่อเลือก SERVICE_ID (อัปเดต DEAL_NAME)
    # ==========================================
    def on_service_id_selected(self, event=None):
        selected_srv = self.od_srv_id.get()
        
        # 1. อัปเดต PROP_TYPE (ดึงจาก Google Sheet)
        if selected_srv in self.service_mapping:
            prop1 = self.service_mapping[selected_srv]['PROP_1_TYPE']
            prop2 = self.service_mapping[selected_srv]['PROP_2_TYPE']
            self.od_prop_17.set(prop1)
            self.od_prop_18.set(prop2) 
            self.log_message(f"[{time.strftime('%H:%M:%S')}] เลือก SERVICE_ID: {selected_srv} -> อัปเดต PROP_TYPE อัตโนมัติ")

        # 2. กรองและอัปเดต DEAL_NAME Dropdown ตาม SERVICE_ID (ทั้ง PACKAGE_INFO 1, 2 และ 3)
        available_deals = []
        if selected_srv in self.service_deal_mapping:
            available_deals = sorted(list(self.service_deal_mapping[selected_srv].keys()))

        if hasattr(self, 'deal_cb'):
            # อัปเดตตัวเลือกใน Dropdown PACKAGE_INFO 1
            self.deal_cb['values'] = available_deals
            self.od_pkg1_bundle_name.set('')
            self.od_pkg1_prod_name.set('')
            self.od_pkg1_name.set('')
            self.od_pkg1_id.set('')

        if hasattr(self, 'deal_cb3'):
            # อัปเดตตัวเลือกใน Dropdown PACKAGE_INFO 2
            self.deal_cb3['values'] = available_deals
            self.od_pkg3_b1_name.set('')
            self.od_pkg3_b1_prod.set('')
            self.od_pkg3_name.set('')
            self.od_pkg3_id.set('')

        if hasattr(self, 'deal_cb2'):
            # อัปเดตตัวเลือกใน Dropdown PACKAGE_INFO 3
            self.deal_cb2['values'] = available_deals
            self.od_pkg2_b1_name.set('')
            self.od_pkg2_b1_prod.set('')
            self.od_pkg2_name.set('')
            self.od_pkg2_id.set('')

        self.log_message(f"[UI] กรอง DEAL_NAME สำหรับ SERVICE_ID '{selected_srv}' เรียบร้อย (พบ {len(available_deals)} รายการ)")

    # ==========================================
    # ฟังก์ชันเมื่อเลือก DEAL_NAME (PACKAGE_INFO 1)
    # ==========================================
    def on_deal_name_selected(self, event=None):
        selected_srv = self.od_srv_id.get()
        selected_deal = self.od_pkg1_bundle_name.get()
        
        if selected_srv in self.service_deal_mapping and selected_deal in self.service_deal_mapping[selected_srv]:
            matched_plan = self.service_deal_mapping[selected_srv][selected_deal]
            self.od_pkg1_prod_name.set(selected_deal)
            self.od_pkg1_name.set(matched_plan)
            self.od_pkg1_id.set(matched_plan)
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [PKG1] เลือก DEAL_NAME: '{selected_deal}' -> อัปเดต DEAL_NAME 2, PLAN_NAME และ PACKAGE_ID สำเร็จ")

    # ==========================================
    # ฟังก์ชันเมื่อเลือก DEAL_NAME (PACKAGE_INFO 2)
    # ==========================================
    def on_deal3_name_selected(self, event=None):
        selected_srv = self.od_srv_id.get()
        selected_deal = self.od_pkg3_b1_name.get()

        if selected_srv in self.service_deal_mapping and selected_deal in self.service_deal_mapping[selected_srv]:
            matched_plan = self.service_deal_mapping[selected_srv][selected_deal]
            self.od_pkg3_b1_prod.set(selected_deal)
            self.od_pkg3_name.set(matched_plan)
            self.od_pkg3_id.set(matched_plan)
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [PKG2] เลือก DEAL_NAME: '{selected_deal}' -> อัปเดต DEAL_NAME 2, PLAN_NAME และ PACKAGE_ID สำเร็จ")

    # ==========================================
    # ฟังก์ชันเมื่อเลือก DEAL_NAME (PACKAGE_INFO 3)
    # ==========================================
    def on_deal2_name_selected(self, event=None):
        selected_srv = self.od_srv_id.get()
        selected_deal = self.od_pkg2_b1_name.get()

        if selected_srv in self.service_deal_mapping and selected_deal in self.service_deal_mapping[selected_srv]:
            matched_plan = self.service_deal_mapping[selected_srv][selected_deal]
            self.od_pkg2_b1_prod.set(selected_deal)
            self.od_pkg2_name.set(matched_plan)
            self.od_pkg2_id.set(matched_plan)
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [PKG3] เลือก DEAL_NAME: '{selected_deal}' -> อัปเดต DEAL_NAME 2, PLAN_NAME และ PACKAGE_ID สำเร็จ")

    def setup_ba_tab(self):
        self.ba_scroll = ScrollableFrame(self.tab_ba)
        self.ba_scroll.pack(fill="both", expand=True)
        content = self.ba_scroll.content

        # 1. Environment Card
        env_frame = ttk.LabelFrame(content, text=" ⚙️ 1. กำหนด Environment & API Endpoint ")
        env_frame.pack(fill='x', padx=14, pady=8)

        self.ba_env_var = tk.StringVar(value="DEV")
        ttk.Label(env_frame, text="Environment:", style="FieldLabel.TLabel").grid(row=0, column=0, sticky='w', padx=(14, 10), pady=6)
        env_cb = ttk.Combobox(env_frame, textvariable=self.ba_env_var, values=["DEV", "PROD", "NEW DB"], state="readonly", width=14)
        env_cb.grid(row=0, column=1, sticky='w', padx=(0, 14), pady=6)
        env_cb.bind("<<ComboboxSelected>>", self.update_ba_url)

        self.ba_url_var = tk.StringVar(value=self.api_urls["BA"]["DEV"])
        ttk.Label(env_frame, text="Endpoint URL:", style="FieldLabel.TLabel").grid(row=1, column=0, sticky='w', padx=(14, 10), pady=6)
        ttk.Entry(env_frame, textvariable=self.ba_url_var, width=72).grid(row=1, column=1, columnspan=2, sticky='w', padx=(0, 14), pady=6)

        # 2. ACCTINFO & ORDERS Card
        acct_frame = ttk.LabelFrame(content, text=" 📌 2. ข้อมูลบัญชีและคำสั่งซื้อ (ACCTINFO & ORDERS) ")
        acct_frame.pack(fill='x', padx=14, pady=8)

        self.ba_no_var = tk.StringVar(value="12222293")
        self.create_form_row(acct_frame, "Billing Account No (BA):", self.ba_no_var, 0, width=42, hint="รหัสบัญชีเรียกเก็บเงิน")

        self.ba_biz_type_var = tk.StringVar(value="3 - Residential")
        ttk.Label(acct_frame, text="BUSINESS_TYPE:", style="FieldLabel.TLabel").grid(row=1, column=0, sticky='w', padx=(14, 10), pady=4)
        biz_opts = [
            "1 - Business (นิติบุคคล/บริษัท/ห้าง ร้าน)", "2 - Government (หน่วยงานรัฐ)",
            "3 - Residential", "4 - Carrier/Operator/NONPOTs", "5 - MKT Arm", "6 - ISP",
            "7 - Reseller/Agent", "8 - ธุรกิจ กสท", "9 - สถานทูต/องค์กรระหว่างประเทศ",
            "10 - PREPAID", "11 - องค์กรเอกชน", "12 - องค์กรภาครัฐ",
            "13 - Carrier/Operator", "14 - บุคคลทั่วไป", "15 - Non Charge"
        ]
        biz_cb = ttk.Combobox(acct_frame, textvariable=self.ba_biz_type_var, values=biz_opts, state="readonly", width=46)
        biz_cb.grid(row=1, column=1, sticky='w', padx=(0, 14), pady=4)

        self.ba_eff_t_var = tk.StringVar(value="2026-05-01T07:00:00Z")
        self.create_form_row(acct_frame, "EFFECTIVE_T:", self.ba_eff_t_var, 2, width=42, hint="วันมีผล (ISO 8601 UTC)")

        # 3. PROFILES Card
        prof_frame = ttk.LabelFrame(content, text=" 🏢 3. ข้อมูลโปรไฟล์และรอบบิล (PROFILES & BILLING) ")
        prof_frame.pack(fill='x', padx=14, pady=8)

        self.ba_bill_group_var = tk.StringVar(value="20000")
        self.create_form_row(prof_frame, "BILLING_GROUP:", self.ba_bill_group_var, 0, width=42)

        self.ba_bill_period_var = tk.StringVar(value="M01")
        ttk.Label(prof_frame, text="BILL_PERIOD:", style="FieldLabel.TLabel").grid(row=1, column=0, sticky='w', padx=(14, 10), pady=4)
        bill_period_opts = ["M01", "M10", "M20", "M25", "A50", "B50", "MA1", "MA2", "00I", "03A", "06A", "12A", "02P"]
        bp_cb = ttk.Combobox(prof_frame, textvariable=self.ba_bill_period_var, values=bill_period_opts, state="readonly", width=46)
        bp_cb.grid(row=1, column=1, sticky='w', padx=(0, 14), pady=4)

        self.ba_cust_seg_l1_var = tk.StringVar(value="5")
        self.create_form_row(prof_frame, "CustSegmentL1:", self.ba_cust_seg_l1_var, 2, width=42)

        self.ba_cust_seg_l2_var = tk.StringVar(value="10")
        self.create_form_row(prof_frame, "CustSegmentL2:", self.ba_cust_seg_l2_var, 3, width=42)

        self.ba_cust_seg_l3_var = tk.StringVar(value="100")
        self.create_form_row(prof_frame, "CustSegmentL3:", self.ba_cust_seg_l3_var, 4, width=42)

        self.ba_tax_code_var = tk.StringVar(value="1")
        ttk.Label(prof_frame, text="FRANCHISE_TAX_CODE:", style="FieldLabel.TLabel").grid(row=5, column=0, sticky='w', padx=(14, 10), pady=4)
        tax_opts = ["1", "2", "3", "4"]
        self.tax_cb = ttk.Combobox(prof_frame, textvariable=self.ba_tax_code_var, values=tax_opts, state="normal", width=46)
        self.tax_cb.grid(row=5, column=1, sticky='w', padx=(0, 14), pady=4)

        ttk.Label(prof_frame, text="ℹ️ 1 =Exclude VAT 7% • 2 = VAT 0% • 3 = Non Vat • 4 = Include VAT 7%", style="Hint.TLabel").grid(
            row=6, column=1, sticky='w', padx=(0, 14), pady=(0, 8)
        )

        # Action Button Frame
        action_frame = tk.Frame(content, bg="#f8fafc")
        action_frame.pack(fill='x', padx=14, pady=(16, 24))

        self.btn_send_ba = ttk.Button(action_frame, text="📤 ยิง API Create BA", style="ActionBA.TButton", command=self.send_ba_threaded)
        self.btn_send_ba.pack(side='top', fill='x', ipady=3)

    def setup_order_tab(self):
        self.order_scroll = ScrollableFrame(self.tab_order)
        self.order_scroll.pack(fill="both", expand=True)
        content = self.order_scroll.content

        # 1. Environment Card
        env_frame = ttk.LabelFrame(content, text=" ⚙️ 1. กำหนด Environment & API Endpoint ")
        env_frame.pack(fill='x', padx=14, pady=8)

        self.od_env_var = tk.StringVar(value="DEV")
        ttk.Label(env_frame, text="Environment:", style="FieldLabel.TLabel").grid(row=0, column=0, sticky='w', padx=(14, 10), pady=6)
        env_cb = ttk.Combobox(env_frame, textvariable=self.od_env_var, values=["DEV", "PROD", "NEW DB"], state="readonly", width=14)
        env_cb.grid(row=0, column=1, sticky='w', padx=(0, 14), pady=6)
        env_cb.bind("<<ComboboxSelected>>", self.update_order_url)

        self.od_url_var = tk.StringVar(value=self.api_urls["ORDER"]["DEV"])
        ttk.Label(env_frame, text="Endpoint URL:", style="FieldLabel.TLabel").grid(row=1, column=0, sticky='w', padx=(14, 10), pady=6)
        ttk.Entry(env_frame, textvariable=self.od_url_var, width=72).grid(row=1, column=1, columnspan=2, sticky='w', padx=(0, 14), pady=6)

        # 2. Order Header & Master Service Selection Card (เอา Service ID ขึ้นมาให้เลือกก่อน สะดวกและตรง workflow)
        order_header_frame = ttk.LabelFrame(content, text=" 🎯 2. ข้อมูล Order & บริการหลัก (Master Service) ")
        order_header_frame.pack(fill='x', padx=14, pady=8)

        self.od_ba_no = tk.StringVar(value="12222294")
        self.create_form_row(order_header_frame, "Billing Account No (BA):", self.od_ba_no, 0, width=42, hint="รหัสบัญชีสำหรับผูก Order")

        self.od_eff_t = tk.StringVar(value="2026-05-01T07:00:00Z")
        self.create_form_row(order_header_frame, "EFFECTIVE_T:", self.od_eff_t, 1, width=42, hint="วันมีผล (ISO 8601 UTC)")

        # SERVICE_ID
        ttk.Label(order_header_frame, text="SERVICE_ID (หลัก):", style="FieldLabel.TLabel").grid(row=2, column=0, sticky='w', padx=(14, 10), pady=6)
        self.od_srv_id = tk.StringVar()
        self.srv_cb = ttk.Combobox(order_header_frame, textvariable=self.od_srv_id, values=self.service_list, state="readonly", width=42)
        self.srv_cb.grid(row=2, column=1, sticky='w', padx=(0, 14), pady=6)
        self.srv_cb.bind("<<ComboboxSelected>>", self.on_service_id_selected)
        ttk.Label(order_header_frame, text="💡 เลือก Service ID เพื่อกรอง Deal และ Plan อัตโนมัติ", style="Hint.TLabel").grid(row=2, column=2, sticky='w', padx=(4, 10), pady=6)

        self.od_prop_17 = tk.StringVar()
        self.create_form_row(order_header_frame, "PROP_TYPE 1:", self.od_prop_17, 3, width=42, readonly=True, hint="ดึงจาก Google Sheet")

        self.od_prop_18 = tk.StringVar()
        self.create_form_row(order_header_frame, "PROP_TYPE 2:", self.od_prop_18, 4, width=42, readonly=True, hint="ดึงจาก Google Sheet")

        # 3. PACKAGE_INFO 1 (Base - บังคับ)
        pkg1_frame = ttk.LabelFrame(content, text=" 📦 3. PACKAGE_INFO 1 (Main Base - บังคับส่ง elem: 0) ")
        pkg1_frame.pack(fill='x', padx=14, pady=8)

        self.od_pkg1_bundle_name = tk.StringVar(value="")
        ttk.Label(pkg1_frame, text="DEAL_NAME (เลือก):", style="FieldLabel.TLabel").grid(row=0, column=0, sticky='w', padx=(14, 10), pady=5)
        self.deal_cb = ttk.Combobox(pkg1_frame, textvariable=self.od_pkg1_bundle_name, values=[], state="readonly", width=42)
        self.deal_cb.grid(row=0, column=1, sticky='w', padx=(0, 14), pady=5)
        self.deal_cb.bind("<<ComboboxSelected>>", self.on_deal_name_selected)
        ttk.Label(pkg1_frame, text="เลือกเพื่อโหลด Plan และ Package ID อัตโนมัติ", style="Hint.TLabel").grid(row=0, column=2, sticky='w', padx=(4, 10))

        self.od_pkg1_prod_name = tk.StringVar(value="")
        self.create_form_row(pkg1_frame, "DEAL_NAME 2:", self.od_pkg1_prod_name, 1, width=42, readonly=True)

        self.od_pkg1_name = tk.StringVar(value="")
        self.create_form_row(pkg1_frame, "PLAN_NAME:", self.od_pkg1_name, 2, width=42, readonly=True)

        self.od_pkg1_id = tk.StringVar(value="")
        self.create_form_row(pkg1_frame, "PACKAGE_ID:", self.od_pkg1_id, 3, width=42, readonly=True)

        # 4. PACKAGE_INFO 2 (Optional - elem 1)
        self.chk_pkg3 = tk.BooleanVar(value=False)
        self.pkg2_frame = ttk.LabelFrame(content, text=" 📦 4. PACKAGE_INFO 2 (Optional - ส่ง elem: 1) ")
        self.pkg2_frame.pack(fill='x', padx=14, pady=8)

        chk_btn2 = ttk.Checkbutton(
            self.pkg2_frame, text="เปิดใช้งานชุดที่ 2 (ส่ง PACKAGE_INFO elem 1 ใน API)",
            variable=self.chk_pkg3, command=self._update_pkg_states
        )
        chk_btn2.grid(row=0, column=0, columnspan=2, sticky='w', padx=14, pady=(6, 8))

        self.od_pkg3_b1_name = tk.StringVar(value="")
        ttk.Label(self.pkg2_frame, text="DEAL_NAME (เลือก):", style="FieldLabel.TLabel").grid(row=1, column=0, sticky='w', padx=(14, 10), pady=4)
        self.deal_cb3 = ttk.Combobox(self.pkg2_frame, textvariable=self.od_pkg3_b1_name, values=[], state="readonly", width=42)
        self.deal_cb3.grid(row=1, column=1, sticky='w', padx=(0, 14), pady=4)
        self.deal_cb3.bind("<<ComboboxSelected>>", self.on_deal3_name_selected)

        self.od_pkg3_b1_prod = tk.StringVar(value="")
        self.entry_pkg2_prod = self.create_form_row(self.pkg2_frame, "DEAL_NAME 2:", self.od_pkg3_b1_prod, 2, width=42, readonly=True)

        self.od_pkg3_name = tk.StringVar(value="")
        self.entry_pkg2_plan = self.create_form_row(self.pkg2_frame, "PLAN_NAME:", self.od_pkg3_name, 3, width=42, readonly=True)

        self.od_pkg3_id = tk.StringVar(value="")
        self.entry_pkg2_id = self.create_form_row(self.pkg2_frame, "PACKAGE_ID:", self.od_pkg3_id, 4, width=42, readonly=True)

        # 5. PACKAGE_INFO 3 (Optional - elem 3)
        self.chk_pkg2 = tk.BooleanVar(value=False)
        self.pkg3_frame = ttk.LabelFrame(content, text=" 📦 5. PACKAGE_INFO 3 (Optional - ส่ง elem: 3) ")
        self.pkg3_frame.pack(fill='x', padx=14, pady=8)

        chk_btn3 = ttk.Checkbutton(
            self.pkg3_frame, text="เปิดใช้งานชุดที่ 3 (ส่ง PACKAGE_INFO elem 3 ใน API)",
            variable=self.chk_pkg2, command=self._update_pkg_states
        )
        chk_btn3.grid(row=0, column=0, columnspan=2, sticky='w', padx=14, pady=(6, 8))

        self.od_pkg2_b1_name = tk.StringVar(value="")
        ttk.Label(self.pkg3_frame, text="DEAL_NAME (เลือก):", style="FieldLabel.TLabel").grid(row=1, column=0, sticky='w', padx=(14, 10), pady=4)
        self.deal_cb2 = ttk.Combobox(self.pkg3_frame, textvariable=self.od_pkg2_b1_name, values=[], state="readonly", width=42)
        self.deal_cb2.grid(row=1, column=1, sticky='w', padx=(0, 14), pady=4)
        self.deal_cb2.bind("<<ComboboxSelected>>", self.on_deal2_name_selected)

        self.od_pkg2_b1_prod = tk.StringVar(value="")
        self.entry_pkg3_prod = self.create_form_row(self.pkg3_frame, "DEAL_NAME 2:", self.od_pkg2_b1_prod, 2, width=42, readonly=True)

        self.od_pkg2_name = tk.StringVar(value="")
        self.entry_pkg3_plan = self.create_form_row(self.pkg3_frame, "PLAN_NAME:", self.od_pkg2_name, 3, width=42, readonly=True)

        self.od_pkg2_id = tk.StringVar(value="")
        self.entry_pkg3_id = self.create_form_row(self.pkg3_frame, "PACKAGE_ID:", self.od_pkg2_id, 4, width=42, readonly=True)

        # Set initial enabled/disabled states for optional packages
        self._update_pkg_states()

        # Action Button Frame
        action_frame = tk.Frame(content, bg="#f8fafc")
        action_frame.pack(fill='x', padx=14, pady=(16, 24))

        self.btn_send_order = ttk.Button(action_frame, text="🚀 ยิง API Create Order", style="ActionOrder.TButton", command=self.send_order_threaded)
        self.btn_send_order.pack(side='top', fill='x', ipady=3)

    def _update_pkg_states(self):
        # Update PKG 2 visual state
        is_pkg2_on = self.chk_pkg3.get()
        cb_state = 'readonly' if is_pkg2_on else 'disabled'
        self.deal_cb3.configure(state=cb_state)

        # Update PKG 3 visual state
        is_pkg3_on = self.chk_pkg2.get()
        cb_state3 = 'readonly' if is_pkg3_on else 'disabled'
        self.deal_cb2.configure(state=cb_state3)

    def send_ba_threaded(self):
        threading.Thread(target=self.send_ba, daemon=True).start()

    def send_ba(self):
        if hasattr(self, 'btn_send_ba'):
            self.root.after(0, lambda: self.btn_send_ba.configure(state='disabled', text="⏳ กำลังส่ง API..."))

        try:
            url = self.ba_url_var.get().strip()
            raw_biz_type = self.ba_biz_type_var.get()
            clean_biz_type = raw_biz_type.split(" - ")[0].strip()

            raw_tax = self.ba_tax_code_var.get().strip()
            clean_tax = raw_tax.split(" - ")[0].strip()
            
            payload = {
                "ACCTINFO": [{
                    "elem": "0", "NTH_FLD_BILLING_ACCOUNT_NO": self.ba_no_var.get(),
                    "CURRENCY": "764", "BAL_INFO": [{"elem": "0"}],
                    "BUSINESS_TYPE": clean_biz_type, "POID": "0.0.0.1 /account -1 0"
                }],
                "BILLINFO": [{
                    "elem": "0", "BAL_INFO": [{"elem": "0"}], "BILLINFO_ID": "1689331810",
                    "PAY_TYPE": "10001", "POID": "0.0.0.1 /billinfo -1 0", "ACTG_CYCLE_DOM": 1
                }],
                "CONTEXT_INFO": {"CORRELATION_ID": "2546387808082", "EXTERNAL_USER": "TESTER_TOY"},
                "FLAGS": "0", "LOCALES": [{"elem": "0", "LOCALE": "en_US"}],
                "ORDERS": [{"elem": "0", "ORDER_ID": "0884112284", "ORDER_TYPE": "CBA", "EFFECTIVE_T": self.ba_eff_t_var.get()}],
                "PAYINFO": [{
                    "elem": "0",
                    "INHERITED_INFO": {
                        "INV_INFO": [{"elem": "0", "ADDRESS": "Smile", "CITY": "Tiwanon", "COUNTRY": "TH", "DELIVERY_DESCR": "VAT", "DELIVERY_PREFER": "0", "EMAIL_ADDR": "siripo.na@yipintsoi.com", "INV_TERMS": "0", "NAME": " deekshi", "STATE": "k ", "ZIP": "37845"}]
                    },
                    "INV_TYPE": "0", "NAME": "Cash", "PAY_TYPE": "10001", "POID": "0.0.0.1 /payinfo/invoice -1 0"
                }],
                "POID": "0.0.0.1 /plan -1 0",
                "PROFILES": [{
                    "elem": "1",
                    "INHERITED_INFO": {
                        "NTH_FLD_CUSTOMER_DETAILS": [{
                            "elem": "0", "NTH_FLD_PARENT_ID": "",
                            "NTH_FLD_ADDRESSES": [
                                {"elem": "1", "NTH_FLD_ADDRESS_TYPE": "1", "NTH_FLD_COMPANY_TITLE": "", "COMPANY": "", "NTH_FLD_BUILDING": "", "NTH_FLD_HOUSE_NO": "99", "NTH_FLD_LATITUDE": "", "NTH_FLD_LONGITUDE": "", "NTH_FLD_MOO": "หมู่ที่ 9", "NTH_FLD_ROAD": "", "NTH_FLD_TROK": "", "NTH_FLD_VILLAGE": "", "COUNTY": "ตำบล/แขวงตลาดขวัญ", "CITY": "อำเภอ/เขตเมืองนนทบุรี", "COUNTRY": "764", "STATE": "นนทบุรี", "TITLE": "คุณ", "FIRST_NAME": "ศิริน", "LAST_NAME": "นาคทอง", "MIDDLE_NAME": "", "PHONE": "", "ZIP": "11000"},
                                {"elem": "2", "NTH_FLD_ADDRESS_TYPE": "2", "NTH_FLD_COMPANY_TITLE": "", "COMPANY": "", "NTH_FLD_BUILDING": "", "NTH_FLD_HOUSE_NO": "99", "NTH_FLD_LATITUDE": "", "NTH_FLD_LONGITUDE": "", "NTH_FLD_MOO": "หมู่ที่ 9", "NTH_FLD_ROAD": "", "NTH_FLD_TROK": "", "NTH_FLD_VILLAGE": "", "COUNTY": "ตำบล/แขวงตลาดขวัญ", "CITY": "อำเภอ/เขตเมืองนนทบุรี", "COUNTRY": "764", "STATE": "นนทบุรี", "TITLE": "คุณ", "FIRST_NAME": "ศิริน", "LAST_NAME": "นาคทอง", "MIDDLE_NAME": "", "PHONE": "", "ZIP": "11000"}
                            ],
                            "NTH_FLD_BILLING_GROUP": self.ba_bill_group_var.get(),
                            "NTH_FLD_BILL_COUNTY": "แขวงห้วยขวาง", "NTH_FLD_BILL_DISP_METHOD": "1",
                            "NTH_FLD_BILL_FMT_OPT": "1", "NTH_FLD_BILL_PERIOD": self.ba_bill_period_var.get(),
                            "NTH_FLD_CONTACT_ADDRESS": [{"elem": "1", "NTH_FLD_ADDRESS_TYPE": "1", "EMAIL_ADDR": "siripo.na@yipintsoi.com", "FAX_PHONE": "99900999000", "FIRST_NAME": "Gojo", "HOME_PHONE": "99900999000", "LAST_NAME": "Saturo", "MIDDLE_NAME": "S", "PHONE": "99900999000", "TITLE": "Mr."}],
                            "NTH_FLD_UNIT_COST_CENTER": "2Q10209", "NTH_FLD_CUSTOMER_GROUP": "510100",
                            "NTH_FLD_CUSTOMER_SERVICE_CENTERS": [{"elem": "4", "NTH_FLD_SERVICE_CENTER_ADDR": "BKK", "NTH_FLD_SERVICE_CENTER_ID": "1000", "NTH_FLD_SERVICE_CENTER_NAME": "1000 กน.", "NTH_FLD_SERVICE_CENTER_TYPE": "4"}],
                            "NTH_FLD_EMPLOYEE_ID": "11", "NTH_FLD_EXTERNAL_ID": "3424233232323232",
                            "NTH_FLD_EXTERNAL_ID_TYPE": "223",
                            "NTH_FLD_EXT_DATA": [
                                {"PARAM_NAME": "CustSegmentL1", "PARAM_VALUE": self.ba_cust_seg_l1_var.get(), "elem": "20078"},
                                {"PARAM_NAME": "CustSegmentL2", "PARAM_VALUE": self.ba_cust_seg_l2_var.get(), "elem": "20079"},
                                {"PARAM_NAME": "CustSegmentL3", "PARAM_VALUE": self.ba_cust_seg_l3_var.get(), "elem": "20080"}
                            ],
                            "NTH_FLD_FRANCHISE_TAX_CODE": clean_tax,
                            "NTH_FLD_LANG_CODE": "22", "NTH_FLD_NATIONALITY": "TH", "NTH_FLD_NO_BILL": "0",
                            "NTH_FLD_PREFERRED_LANG": "22", "NTH_FLD_RATE_CLASS": "2",
                            "NTH_FLD_REGISTER_TYPE": " ", "NTH_FLD_REGISTRATION_FORM": "3432",
                            "NTH_FLD_SALES_CENTER_ID": "1000", "NTH_FLD_SALES_CODE": "ccrhcr07",
                            "NTH_FLD_SSN_ID": self.generate_thai_id(),
                            "NTH_FLD_VAT_COUNTY": "แขวงห้วยขวาง", "NTH_FLD_VAT_DISP_METHOD": "1",
                            "NTH_FLD_VIP_CODE": "0", "CREDIT_THRESHOLDS": "5000",
                            "CUSTOMER_SEGMENT": "1", "CUSTOMER_TYPE": "1",
                            "EMAIL_ADDR": "siripo.na@yipintsoi.com"
                        }]
                    },
                    "PROFILE_OBJ": "0.0.0.1 /profile/nth_customer_details -1 0"
                }],
                "TXN_FLAGS": "2"
            }
            self.execute_request(url, payload, "Create BA")
        finally:
            if hasattr(self, 'btn_send_ba'):
                self.root.after(0, lambda: self.btn_send_ba.configure(state='normal', text="📤 ยิง API Create BA"))

    def send_order_threaded(self):
        threading.Thread(target=self.send_order, daemon=True).start()

    def send_order(self):
        if hasattr(self, 'btn_send_order'):
            self.root.after(0, lambda: self.btn_send_order.configure(state='disabled', text="⏳ กำลังส่ง API..."))

        try:
            url = self.od_url_var.get().strip()
            ts = str(int(time.time()))
            rand_phone = str(random.randint(800000000, 999999999))
            
            pkg1_bundles = [{
                "elem": "1",
                "Name": self.od_pkg1_bundle_name.get(),
                "NTH_FLD_BUNDLE_TYPE": "7",  
                "PRODUCTS": [{
                    "elem": "0", "NTH_FLD_OVERRIDE_RUM": 1, "DESCR": "", 
                    "NAME": self.od_pkg1_prod_name.get(), "QUANTITY": "1"
                }]
            }]

            packages = [{
                "elem": "0",
                "NTH_FLD_PACKAGE_TYPE": "Base", 
                "BUNDLE_INFO": pkg1_bundles,
                "NAME": self.od_pkg1_name.get(),
                "PACKAGE_ID": self.od_pkg1_id.get()
            }]

            # PACKAGE_INFO 2 (elem 1)
            if self.chk_pkg3.get():
                packages.append({
                    "elem": "1",
                    "NTH_FLD_PACKAGE_TYPE": "Base",
                    "BUNDLE_INFO": [{
                        "elem": "1", "Name": self.od_pkg3_b1_name.get(), "NTH_FLD_BUNDLE_TYPE": "7",
                        "PRODUCTS": [{"elem": "0", "NTH_FLD_OVERRIDE_RUM": 1, "DESCR": "", "NAME": self.od_pkg3_b1_prod.get(), "QUANTITY": "1"}]
                    }],
                    "NAME": self.od_pkg3_name.get(),
                    "PACKAGE_ID": self.od_pkg3_id.get()
                })

            # PACKAGE_INFO 3 (elem 3)
            if self.chk_pkg2.get():
                packages.append({
                    "elem": "3",
                    "NTH_FLD_PACKAGE_TYPE": "Base",
                    "BUNDLE_INFO": [{
                        "elem": "1", "Name": self.od_pkg2_b1_name.get(), "NTH_FLD_BUNDLE_TYPE": "7",
                        "PRODUCTS": [{"elem": "0", "NTH_FLD_OVERRIDE_RUM": 1, "DESCR": "", "NAME": self.od_pkg2_b1_prod.get(), "QUANTITY": "1"}]
                    }],
                    "NAME": self.od_pkg2_name.get(),
                    "PACKAGE_ID": self.od_pkg2_id.get()
                })

            payload = {
                "NTH_FLD_BILLING_ACCOUNT_NO": self.od_ba_no.get(),
                "NTH_FLD_SERVICE_DETAILS": [{
                    "elem": "0",
                    "NTH_FLD_CONTACT_ADDRESS": [
                        {"elem": "2", "NTH_FLD_ADDRESS_TYPE": "2", "EMAIL_ADDR": "siripo.na@yipintsoi.com", "FAX_PHONE": rand_phone, "FIRST_NAME": rand_phone, "HOME_PHONE": "1212312121", "LAST_NAME": "Smith", "MIDDLE_NAME": "John", "PHONE": "123123", "TITLE": "Mr"}
                    ],
                    "NTH_FLD_EXT_DATA": [
                        {"elem": "10011", "NTH_FLD_PARAM_ID": "10011", "PARAM_NAME": "ContractStartDT", "PARAM_VALUE": "01/08/2019"}
                    ],
                    "NTH_FLD_SERVICE_GROUP": "corporate internet"
                }],
                "CONTEXT_INFO": {"CORRELATION_ID": "321269766374375", "EXTERNAL_USER": "TesterToy"},
                "ORDERS": [{"elem": "0", "EFFECTIVE_T": self.od_eff_t.get(), "ORDER_ID": "0884112284", "ORDER_TYPE": "CNO"}],
                "PACKAGE_INFO": packages,
                "POID": "0.0.0.1 /plan -1 7",
                "SERVICES": [{
                    "elem": "0",
                    "ALIAS_LIST": [
                        {"elem": "0", "NTH_FLD_PROP_TYPE": self.od_prop_17.get(), "NAME": f"5{ts}"},
                        {"elem": "1", "NTH_FLD_PROP_TYPE": self.od_prop_18.get(), "NAME": ts}
                    ],
                    "SERVICE_ID": self.od_srv_id.get()
                }]
            }
            self.execute_request(url, payload, "Create Order")
        finally:
            if hasattr(self, 'btn_send_order'):
                self.root.after(0, lambda: self.btn_send_order.configure(state='normal', text="🚀 ยิง API Create Order"))

    def create_input(self, parent, label_text, str_var, row):
        ttk.Label(parent, text=label_text).grid(row=row, column=0, sticky='w', padx=10, pady=2)
        entry = ttk.Entry(parent, textvariable=str_var, width=50)
        entry.grid(row=row, column=1, sticky='w', padx=10, pady=2)

    def execute_request(self, url, payload, api_name):
        curr_time = time.strftime('%Y-%m-%d %H:%M:%S')
        out_msg = []
        out_msg.append("=" * 62)
        out_msg.append(f"🚀 [{curr_time}] เริ่มยิง API: {api_name}")
        out_msg.append(f"🌐 Target URL: {url}")
        
        if not url.startswith("http"):
            out_msg.append("⚠️ [WARNING] URL ควรขึ้นต้นด้วย http:// หรือ https://")
            
        payload_str = json.dumps(payload, indent=2, ensure_ascii=False)
        out_msg.append(f"📦 Payload Size: {len(payload_str):,} characters")
            
        try:
            headers = {'Content-Type': 'application/json'}
            response = requests.post(url, json=payload, headers=headers, timeout=45)
            status_code = response.status_code
            status_icon = "✅" if 200 <= status_code < 300 else "❌"
            out_msg.append(f"{status_icon} >> HTTP Status Code: {status_code}")
            
            try:
                resp_json = response.json()
                out_msg.append(f">> Response (JSON):\n{json.dumps(resp_json, indent=2, ensure_ascii=False)}")
            except ValueError:
                out_msg.append(f">> Response (Text):\n{response.text}")
                
        except Exception as e:
            out_msg.append(f"❌ [ERROR] เกิดข้อผิดพลาดในการส่งคำขอ API")
            out_msg.append(f"Detail: {str(e)}")
            
        full_block = "\n".join(out_msg)
        self.log_message(full_block)

if __name__ == "__main__":
    root = tk.Tk()
    app = APIToolApp(root)
    root.mainloop()