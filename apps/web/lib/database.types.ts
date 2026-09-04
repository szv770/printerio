// Generated via `mcp__Supabase__generate_typescript_types` against the live
// `printio` project (hnocxpdfhwmdctfpvoto). Regenerate after every migration:
// this file is derived, not hand-maintained - see supabase/migrations/*.sql
// for the source of truth.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      agents: {
        Row: {
          created_at: string;
          device_secret_hash: string | null;
          enrollment_code: string | null;
          enrollment_code_expires_at: string | null;
          id: string;
          last_seen_at: string | null;
          name: string;
          organization_id: string;
          status: string;
          version: string | null;
        };
        Insert: {
          created_at?: string;
          device_secret_hash?: string | null;
          enrollment_code?: string | null;
          enrollment_code_expires_at?: string | null;
          id?: string;
          last_seen_at?: string | null;
          name: string;
          organization_id: string;
          status?: string;
          version?: string | null;
        };
        Update: {
          created_at?: string;
          device_secret_hash?: string | null;
          enrollment_code?: string | null;
          enrollment_code_expires_at?: string | null;
          id?: string;
          last_seen_at?: string | null;
          name?: string;
          organization_id?: string;
          status?: string;
          version?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "agents_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      approval_actions: {
        Row: {
          approver_id: string;
          created_at: string;
          decision: string;
          id: string;
          job_id: string;
          reason: string | null;
        };
        Insert: {
          approver_id: string;
          created_at?: string;
          decision: string;
          id?: string;
          job_id: string;
          reason?: string | null;
        };
        Update: {
          approver_id?: string;
          created_at?: string;
          decision?: string;
          id?: string;
          job_id?: string;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "approval_actions_approver_id_fkey";
            columns: ["approver_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "approval_actions_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "print_jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_logs: {
        Row: {
          action: string;
          actor_id: string | null;
          created_at: string;
          id: string;
          metadata: Json;
          organization_id: string | null;
          target_id: string | null;
          target_type: string | null;
        };
        Insert: {
          action: string;
          actor_id?: string | null;
          created_at?: string;
          id?: string;
          metadata?: Json;
          organization_id?: string | null;
          target_id?: string | null;
          target_type?: string | null;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          created_at?: string;
          id?: string;
          metadata?: Json;
          organization_id?: string | null;
          target_id?: string | null;
          target_type?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_logs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      group_members: {
        Row: { created_at: string; group_id: string; user_id: string };
        Insert: { created_at?: string; group_id: string; user_id: string };
        Update: { created_at?: string; group_id?: string; user_id?: string };
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "group_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      groups: {
        Row: { created_at: string; id: string; kind: string; name: string; organization_id: string };
        Insert: { created_at?: string; id?: string; kind?: string; name: string; organization_id: string };
        Update: { created_at?: string; id?: string; kind?: string; name?: string; organization_id?: string };
        Relationships: [
          {
            foreignKeyName: "groups_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      monthly_usage: {
        Row: {
          color_weighted_used: number;
          id: string;
          organization_id: string;
          pdf_pages_used: number;
          period: string;
          physical_sheets_used: number;
          printed_sides_used: number;
          reserved_color_weighted: number;
          reserved_pdf_pages: number;
          reserved_physical_sheets: number;
          reserved_printed_sides: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          color_weighted_used?: number;
          id?: string;
          organization_id: string;
          pdf_pages_used?: number;
          period: string;
          physical_sheets_used?: number;
          printed_sides_used?: number;
          reserved_color_weighted?: number;
          reserved_pdf_pages?: number;
          reserved_physical_sheets?: number;
          reserved_printed_sides?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          color_weighted_used?: number;
          id?: string;
          organization_id?: string;
          pdf_pages_used?: number;
          period?: string;
          physical_sheets_used?: number;
          printed_sides_used?: number;
          reserved_color_weighted?: number;
          reserved_pdf_pages?: number;
          reserved_physical_sheets?: number;
          reserved_printed_sides?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "monthly_usage_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "monthly_usage_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      organization_invitations: {
        Row: {
          code: string | null;
          created_at: string;
          created_by: string;
          email: string | null;
          expires_at: string | null;
          id: string;
          max_uses: number | null;
          organization_id: string;
          role: string;
          uses_count: number;
        };
        Insert: {
          code?: string | null;
          created_at?: string;
          created_by: string;
          email?: string | null;
          expires_at?: string | null;
          id?: string;
          max_uses?: number | null;
          organization_id: string;
          role?: string;
          uses_count?: number;
        };
        Update: {
          code?: string | null;
          created_at?: string;
          created_by?: string;
          email?: string | null;
          expires_at?: string | null;
          id?: string;
          max_uses?: number | null;
          organization_id?: string;
          role?: string;
          uses_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: "organization_invitations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      organization_members: {
        Row: {
          created_at: string;
          department: string | null;
          organization_id: string;
          role: string;
          status: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          department?: string | null;
          organization_id: string;
          role?: string;
          status?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          department?: string | null;
          organization_id?: string;
          role?: string;
          status?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "organization_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      organization_settings: {
        Row: {
          default_policy_action: string;
          job_approval_expiry_hours: number;
          job_lease_minutes: number;
          max_upload_size_bytes: number;
          organization_id: string;
          quota_basis: string;
          retention_completed_days: number;
          retention_failed_days: number;
          retention_pending_days: number | null;
          retention_rejected_days: number;
          updated_at: string;
        };
        Insert: {
          default_policy_action?: string;
          job_approval_expiry_hours?: number;
          job_lease_minutes?: number;
          max_upload_size_bytes?: number;
          organization_id: string;
          quota_basis?: string;
          retention_completed_days?: number;
          retention_failed_days?: number;
          retention_pending_days?: number | null;
          retention_rejected_days?: number;
          updated_at?: string;
        };
        Update: {
          default_policy_action?: string;
          job_approval_expiry_hours?: number;
          job_lease_minutes?: number;
          max_upload_size_bytes?: number;
          organization_id?: string;
          quota_basis?: string;
          retention_completed_days?: number;
          retention_failed_days?: number;
          retention_pending_days?: number | null;
          retention_rejected_days?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_settings_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      organizations: {
        Row: { allowed_domains: string[]; created_at: string; id: string; name: string; slug: string };
        Insert: { allowed_domains?: string[]; created_at?: string; id?: string; name: string; slug: string };
        Update: { allowed_domains?: string[]; created_at?: string; id?: string; name?: string; slug?: string };
        Relationships: [];
      };
      policy_rules: {
        Row: {
          action: string;
          conditions: Json;
          created_at: string;
          enabled: boolean;
          id: string;
          policy_id: string;
          priority: number;
          reason_label: string;
        };
        Insert: {
          action: string;
          conditions?: Json;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          policy_id: string;
          priority?: number;
          reason_label: string;
        };
        Update: {
          action?: string;
          conditions?: Json;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          policy_id?: string;
          priority?: number;
          reason_label?: string;
        };
        Relationships: [
          {
            foreignKeyName: "policy_rules_policy_id_fkey";
            columns: ["policy_id"];
            isOneToOne: false;
            referencedRelation: "print_policies";
            referencedColumns: ["id"];
          },
        ];
      };
      print_job_events: {
        Row: {
          actor_id: string | null;
          actor_type: string;
          created_at: string;
          event_type: string;
          id: string;
          job_id: string;
          metadata: Json;
        };
        Insert: {
          actor_id?: string | null;
          actor_type: string;
          created_at?: string;
          event_type: string;
          id?: string;
          job_id: string;
          metadata?: Json;
        };
        Update: {
          actor_id?: string | null;
          actor_type?: string;
          created_at?: string;
          event_type?: string;
          id?: string;
          job_id?: string;
          metadata?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "print_job_events_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "print_jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      print_jobs: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          attempt_count: number;
          booklet_padding_added: number;
          color_mode: string;
          completed_at: string | null;
          copies: number;
          created_at: string;
          created_by: string;
          derived_file_path: string | null;
          duplex: boolean;
          error_message: string | null;
          estimated_cost_cents: number | null;
          estimated_physical_sheets: number;
          estimated_printed_sides: number;
          expires_at: string | null;
          file_size_bytes: number;
          finishing: Json;
          id: string;
          job_number: string;
          lease_expires_at: string | null;
          lease_owner_agent_id: string | null;
          max_attempts: number;
          organization_id: string;
          original_file_name: string;
          original_file_path: string;
          paper_size: string;
          policy_action: string | null;
          policy_reasons: string[];
          printer_id: string | null;
          printer_profile_id: string | null;
          source_pdf_pages: number;
          status: string;
          updated_at: string;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          attempt_count?: number;
          booklet_padding_added?: number;
          color_mode?: string;
          completed_at?: string | null;
          copies?: number;
          created_at?: string;
          created_by: string;
          derived_file_path?: string | null;
          duplex?: boolean;
          error_message?: string | null;
          estimated_cost_cents?: number | null;
          estimated_physical_sheets: number;
          estimated_printed_sides: number;
          expires_at?: string | null;
          file_size_bytes: number;
          finishing?: Json;
          id?: string;
          job_number?: string;
          lease_expires_at?: string | null;
          lease_owner_agent_id?: string | null;
          max_attempts?: number;
          organization_id: string;
          original_file_name: string;
          original_file_path: string;
          paper_size?: string;
          policy_action?: string | null;
          policy_reasons?: string[];
          printer_id?: string | null;
          printer_profile_id?: string | null;
          source_pdf_pages: number;
          status?: string;
          updated_at?: string;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          attempt_count?: number;
          booklet_padding_added?: number;
          color_mode?: string;
          completed_at?: string | null;
          copies?: number;
          created_at?: string;
          created_by?: string;
          derived_file_path?: string | null;
          duplex?: boolean;
          error_message?: string | null;
          estimated_cost_cents?: number | null;
          estimated_physical_sheets?: number;
          estimated_printed_sides?: number;
          expires_at?: string | null;
          file_size_bytes?: number;
          finishing?: Json;
          id?: string;
          job_number?: string;
          lease_expires_at?: string | null;
          lease_owner_agent_id?: string | null;
          max_attempts?: number;
          organization_id?: string;
          original_file_name?: string;
          original_file_path?: string;
          paper_size?: string;
          policy_action?: string | null;
          policy_reasons?: string[];
          printer_id?: string | null;
          printer_profile_id?: string | null;
          source_pdf_pages?: number;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "print_jobs_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_lease_owner_agent_id_fkey";
            columns: ["lease_owner_agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_printer_id_fkey";
            columns: ["printer_id"];
            isOneToOne: false;
            referencedRelation: "printers";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "print_jobs_printer_profile_id_fkey";
            columns: ["printer_profile_id"];
            isOneToOne: false;
            referencedRelation: "printer_profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      print_policies: {
        Row: {
          applies_to_role: string[] | null;
          created_at: string;
          enabled: boolean;
          id: string;
          name: string;
          organization_id: string;
        };
        Insert: {
          applies_to_role?: string[] | null;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          name: string;
          organization_id: string;
        };
        Update: {
          applies_to_role?: string[] | null;
          created_at?: string;
          enabled?: boolean;
          id?: string;
          name?: string;
          organization_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "print_policies_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      printer_profiles: {
        Row: {
          agent_id: string;
          created_at: string;
          declared_capabilities: Json;
          declared_paper_sizes: string[];
          id: string;
          is_default: boolean;
          key: string;
          label: string;
          pricing: Json | null;
          printer_id: string;
          windows_queue_name: string;
        };
        Insert: {
          agent_id: string;
          created_at?: string;
          declared_capabilities?: Json;
          declared_paper_sizes?: string[];
          id?: string;
          is_default?: boolean;
          key: string;
          label: string;
          pricing?: Json | null;
          printer_id: string;
          windows_queue_name: string;
        };
        Update: {
          agent_id?: string;
          created_at?: string;
          declared_capabilities?: Json;
          declared_paper_sizes?: string[];
          id?: string;
          is_default?: boolean;
          key?: string;
          label?: string;
          pricing?: Json | null;
          printer_id?: string;
          windows_queue_name?: string;
        };
        Relationships: [
          {
            foreignKeyName: "printer_profiles_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "printer_profiles_printer_id_fkey";
            columns: ["printer_id"];
            isOneToOne: false;
            referencedRelation: "printers";
            referencedColumns: ["id"];
          },
        ];
      };
      printers: {
        Row: {
          created_at: string;
          id: string;
          last_status_at: string | null;
          location: string | null;
          model: string | null;
          name: string;
          organization_id: string;
          snmp_config: Json;
          status: string;
          vendor: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          last_status_at?: string | null;
          location?: string | null;
          model?: string | null;
          name: string;
          organization_id: string;
          snmp_config?: Json;
          status?: string;
          vendor?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          last_status_at?: string | null;
          location?: string | null;
          model?: string | null;
          name?: string;
          organization_id?: string;
          snmp_config?: Json;
          status?: string;
          vendor?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "printers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          email: string;
          id: string;
          platform_role: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email: string;
          id: string;
          platform_role?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          email?: string;
          id?: string;
          platform_role?: string;
        };
        Relationships: [];
      };
      quotas: {
        Row: {
          created_at: string;
          id: string;
          limit_value: number;
          organization_id: string;
          period: string;
          scope_type: string;
          scope_value: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          limit_value: number;
          organization_id: string;
          period?: string;
          scope_type: string;
          scope_value?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          limit_value?: number;
          organization_id?: string;
          period?: string;
          scope_type?: string;
          scope_value?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "quotas_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      remote_commands: {
        Row: {
          agent_id: string;
          command: string;
          completed_at: string | null;
          created_at: string;
          id: string;
          issued_by: string;
          organization_id: string;
          payload: Json;
          printer_id: string | null;
          result: Json | null;
          status: string;
        };
        Insert: {
          agent_id: string;
          command: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          issued_by: string;
          organization_id: string;
          payload?: Json;
          printer_id?: string | null;
          result?: Json | null;
          status?: string;
        };
        Update: {
          agent_id?: string;
          command?: string;
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          issued_by?: string;
          organization_id?: string;
          payload?: Json;
          printer_id?: string | null;
          result?: Json | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "remote_commands_agent_id_fkey";
            columns: ["agent_id"];
            isOneToOne: false;
            referencedRelation: "agents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "remote_commands_issued_by_fkey";
            columns: ["issued_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "remote_commands_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "remote_commands_printer_id_fkey";
            columns: ["printer_id"];
            isOneToOne: false;
            referencedRelation: "printers";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      adjust_monthly_usage: {
        Args: {
          p_color_weighted: number;
          p_limit: number | null;
          p_mode: string;
          p_organization_id: string;
          p_pdf_pages: number;
          p_period: string;
          p_physical_sheets: number;
          p_printed_sides: number;
          p_quota_basis: string;
          p_user_id: string;
        };
        Returns: boolean;
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;
type DefaultSchema = DatabaseWithoutInternals["public"];

export type Tables<T extends keyof DefaultSchema["Tables"]> = DefaultSchema["Tables"][T]["Row"];
export type TablesInsert<T extends keyof DefaultSchema["Tables"]> = DefaultSchema["Tables"][T]["Insert"];
export type TablesUpdate<T extends keyof DefaultSchema["Tables"]> = DefaultSchema["Tables"][T]["Update"];
