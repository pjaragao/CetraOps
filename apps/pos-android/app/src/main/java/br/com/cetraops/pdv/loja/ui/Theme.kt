package br.com.cetraops.pdv.loja.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val colors = lightColorScheme(
    primary = Color(0xFF7C3AED), onPrimary = Color.White,
    secondary = Color(0xFF1F2937), onSecondary = Color.White,
    error = Color(0xFFDC2626), surface = Color.White, background = Color(0xFFF8F7FB),
    surfaceVariant = Color(0xFFF1EEF8),
)

// telas pequenas (5"): textos um pouco menores que o padrão
private val type = Typography(
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 15.sp),
    bodyMedium = TextStyle(fontSize = 14.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun PdvTheme(content: @Composable () -> Unit) = MaterialTheme(colorScheme = colors, typography = type, content = content)
