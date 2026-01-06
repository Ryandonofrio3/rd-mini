"""
Raindrop SDK Plugins

Optional plugins for extending SDK behavior.
"""

from rd_mini.plugins.pii import PiiPlugin, create_pii_plugin

__all__ = [
    "PiiPlugin",
    "create_pii_plugin",
]

# OTEL plugin is conditionally imported to avoid requiring opentelemetry
try:
    from rd_mini.plugins.otel import OtelPlugin, create_otel_plugin

    __all__.extend(["OtelPlugin", "create_otel_plugin"])
except ImportError:
    pass
